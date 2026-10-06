import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { WinnrAuthContext } from '@/lib/winnr/server'
import { WinnrApiError } from '@/lib/winnr/server'
import type { OutreachEventService } from '@/lib/outreach/events'
import type { OperationsClaim, OperationsRepository, PhaseOutcome, TickResult } from './core'

/** The one canonical outbox consumer that hydrates reply bodies. */
export const BODY_CONSUMER = 'winnr.ingestion.body'
/** Body outbox lease in seconds; provider work must finish inside it. */
export const BODY_LEASE_SECONDS = 20
/** Safety margin so hydration can never outlive its fencing lease. */
const BODY_LEASE_SAFETY_MS = 2_000
/** Budget held back from the phase so settlement can still be attempted. */
export const SETTLEMENT_RESERVE_MS = 4_000

export interface BodyConsumerDeps {
  events: OutreachEventService
  hydrate(actor: WinnrAuthContext, receiptId: string, deadlineAt?: number): Promise<{ bodyReady: boolean; reason?: string }>
}

export interface OperationsPorts {
  repository: OperationsRepository
  dispatch(actor: WinnrAuthContext, campaignId: string, deadlineAt?: number): Promise<PhaseOutcome>
  body(actor: WinnrAuthContext, deadlineAt?: number): Promise<PhaseOutcome>
  decision(actor: WinnrAuthContext, deadlineAt?: number): Promise<PhaseOutcome>
  reply(actor: WinnrAuthContext, deadlineAt?: number): Promise<PhaseOutcome>
  now(): number
}

const receiptIdSchema = z.uuid()

/** Read the receipt ID from the canonical `email.received` event payload. */
export function readReceiptId(event: { type: string; data: unknown }): string | null {
  if (event.type !== 'email.received') return null
  const data = z.record(z.string(), z.unknown()).safeParse(event.data)
  if (!data.success) return null
  const parsed = receiptIdSchema.safeParse(data.data['receiptId'])
  return parsed.success ? parsed.data : null
}

/**
 * Body phase. Claims the canonical outbox job under a 021 fencing lease, then
 * either acks a hydrated body or reports an explicit retryable failure. A body
 * that is not ready is never acknowledged and never marked unknown, so it stays
 * eligible/actionable instead of being silently reported as processed.
 */
export function createBodyPhasePort(deps: BodyConsumerDeps) {
  return async (actor: WinnrAuthContext, deadlineAt?: number): Promise<PhaseOutcome> => {
    const leaseToken = randomUUID()
    // Bound hydration by both the absolute request deadline and this claim's
    // own fencing lease. The lease is 20s; reserving a safety margin means a
    // slow provider path fails retryable *before* it can ever produce a stale
    // acknowledgement.
    const claimStartedAt = Date.now()
    const effectiveDeadline =
      deadlineAt === undefined ? undefined : Math.min(deadlineAt, claimStartedAt + BODY_LEASE_SECONDS * 1000 - BODY_LEASE_SAFETY_MS)
    let claimed
    try {
      claimed = await deps.events.claim({
        organizationId: actor.organizationId,
        consumer: BODY_CONSUMER,
        leaseToken,
        leaseSeconds: BODY_LEASE_SECONDS,
        limit: 1,
        ...(effectiveDeadline === undefined ? {} : { deadlineAt: effectiveDeadline }),
      })
    } catch {
      return { status: 'blocked', reason: 'body_claim_unavailable', modelCalls: 0, smtpAttempts: 0 }
    }
    const job = claimed.jobs[0]
    if (!job) return { status: 'idle', reason: 'no_body_job', modelCalls: 0, smtpAttempts: 0 }

    const receiptId = readReceiptId(job.event)
    const fingerprint = job.event.sourceEventId
    const fail = async (reason: string, retryable: boolean): Promise<PhaseOutcome> => {
      let failed: { result: 'retryable' | 'failed' | 'stale' | 'not_found' }
      try {
        failed = await deps.events.fail({
          organizationId: actor.organizationId,
          outboxId: job.outboxId,
          leaseToken,
          leaseExpiresAt: job.leaseExpiresAt,
          errorCode: reason,
          retryable,
          ...(effectiveDeadline === undefined ? {} : { deadlineAt: effectiveDeadline }),
        })
      } catch {
        return {
          status: 'held',
          reason: 'body_settlement_failed',
          referenceId: receiptId ?? undefined,
          referenceFingerprint: fingerprint,
          modelCalls: 0,
          smtpAttempts: 0,
        }
      }
      // A stale/not_found failure did not transition the job. Report an
      // unsettled hold with the reference instead of pretending the retry
      // transition succeeded.
      if (failed.result === 'stale' || failed.result === 'not_found') {
        return {
          status: 'held',
          reason: `body_settlement_${failed.result}`,
          referenceId: receiptId ?? undefined,
          referenceFingerprint: fingerprint,
          modelCalls: 0,
          smtpAttempts: 0,
        }
      }
      if (!receiptId) {
        return { status: 'blocked', reason: 'body_event_receipt_missing', referenceFingerprint: fingerprint, modelCalls: 0, smtpAttempts: 0 }
      }
      const exhausted = failed.result === 'failed'
      return {
        status: exhausted ? 'blocked' : 'held',
        reason: exhausted ? `${reason}_exhausted` : reason,
        referenceId: receiptId,
        referenceFingerprint: fingerprint,
        modelCalls: 0,
        smtpAttempts: 0,
      }
    }

    if (!receiptId) return fail('body_event_receipt_missing', false)

    let hydrated: { bodyReady: boolean; reason?: string }
    try {
      hydrated = await deps.hydrate(actor, receiptId, effectiveDeadline)
    } catch (error) {
      const reason = error instanceof WinnrApiError ? (error.code ?? 'body_provider_unavailable') : 'body_provider_unavailable'
      return fail(reason, true)
    }
    if (!hydrated.bodyReady) return fail(hydrated.reason ?? 'provider_message_unavailable', true)

    try {
      const acked = await deps.events.ack({
        organizationId: actor.organizationId,
        outboxId: job.outboxId,
        leaseToken,
        leaseExpiresAt: job.leaseExpiresAt,
        ...(effectiveDeadline === undefined ? {} : { deadlineAt: effectiveDeadline }),
      })
      // Only result=acked completes body work. A stale lease or a replaced
      // claim stays held and unsettled with its reference; it is never
      // reported as a successful heartbeat.
      if (acked.result !== 'acked') {
        return { status: 'held', reason: `body_ack_${acked.result}`, referenceId: receiptId, referenceFingerprint: fingerprint, modelCalls: 0, smtpAttempts: 0 }
      }
    } catch {
      return { status: 'held', reason: 'body_ack_failed', referenceId: receiptId, referenceFingerprint: fingerprint, modelCalls: 0, smtpAttempts: 0 }
    }
    return { status: 'completed', reason: 'body_ready', referenceId: receiptId, referenceFingerprint: fingerprint, modelCalls: 0, smtpAttempts: 0 }
  }
}

function classifyPhaseError(error: unknown): string {
  if (error instanceof WinnrApiError) return error.code ?? 'phase_error'
  return 'phase_error'
}

/**
 * Execute exactly one external phase for an already-claimed run. A deadline
 * that has already passed yields a hold without starting any effect; effects
 * are always awaited to completion before settlement, never raced, so a live
 * provider/model mutation can never outlive its settlement.
 */
export async function executeClaimedPhase(ports: OperationsPorts, claim: OperationsClaim, deadline: number): Promise<PhaseOutcome> {
  if (ports.now() >= deadline) {
    return { status: 'held', reason: 'deadline_before_effect', modelCalls: 0, smtpAttempts: 0 }
  }
  const actor: WinnrAuthContext = { userId: claim.actorId, organizationId: claim.organizationId, role: claim.role }
  try {
    switch (claim.phase) {
      case 'campaign':
        if (!claim.campaignId) return { status: 'idle', reason: 'no_active_campaign', modelCalls: 0, smtpAttempts: 0 }
        return await ports.dispatch(actor, claim.campaignId, deadline)
      case 'body':
        return await ports.body(actor, deadline)
      case 'decision':
        return await ports.decision(actor, deadline)
      case 'reply':
        return await ports.reply(actor, deadline)
    }
  } catch (error) {
    return { status: 'blocked', reason: classifyPhaseError(error), modelCalls: 0, smtpAttempts: 0 }
  }
  return { status: 'blocked', reason: 'unknown_phase', modelCalls: 0, smtpAttempts: 0 }
}

/**
 * Claim one phase and settle it. `organizationId` scopes a manual owner/admin
 * tick; omitting it runs the globally fair round-robin used by cron.
 *
 * `deadlineAt` is an absolute epoch-milliseconds request deadline measured from
 * the HTTP entry point (before authentication). The phase runs against that
 * deadline minus a settlement reserve so the claim, every awaited effect and
 * the settlement RPC all stay inside the platform request budget.
 */
export async function runOperationsTick(
  ports: OperationsPorts,
  options: { organizationId?: string; leaseSeconds?: number; deadlineMs?: number; deadlineAt?: number } = {},
): Promise<TickResult> {
  const deadline = options.deadlineAt ?? ports.now() + (options.deadlineMs ?? 25000)
  const phaseDeadline = deadline - SETTLEMENT_RESERVE_MS
  const leaseToken = randomUUID()
  let claim
  try {
    claim = await ports.repository.claim({
      leaseToken,
      leaseSeconds: options.leaseSeconds ?? 25,
      ...(options.organizationId ? { organizationId: options.organizationId } : {}),
      deadlineAt: deadline,
    })
  } catch {
    return { result: 'error', reason: 'claim_unavailable' }
  }
  if (claim.result !== 'claimed') return { result: 'idle', reason: claim.reason }

  const outcome = await executeClaimedPhase(ports, claim, phaseDeadline)
  try {
    const settlement = await ports.repository.settle({
      organizationId: claim.organizationId,
      scopeKey: claim.scopeKey,
      leaseToken: claim.leaseToken,
      leaseExpiresAt: claim.leaseExpiresAt,
      status: outcome.status,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      ...(outcome.attemptId ? { attemptId: outcome.attemptId } : {}),
      ...(outcome.decisionId ? { decisionId: outcome.decisionId } : {}),
      ...(outcome.referenceId ? { referenceId: outcome.referenceId } : {}),
      ...(outcome.referenceFingerprint ? { referenceFingerprint: outcome.referenceFingerprint } : {}),
      modelCalls: outcome.modelCalls,
      smtpAttempts: outcome.smtpAttempts,
      deadlineAt: deadline,
    })
    if (settlement.result !== 'settled') {
      return { result: 'unsettled', phase: claim.phase, organizationId: claim.organizationId, status: outcome.status, reason: 'settlement_rejected' }
    }
  } catch {
    return { result: 'unsettled', phase: claim.phase, organizationId: claim.organizationId, status: outcome.status, reason: 'settlement_unavailable' }
  }
  return {
    result: 'settled',
    phase: claim.phase,
    organizationId: claim.organizationId,
    status: outcome.status,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
    modelCalls: outcome.modelCalls,
    smtpAttempts: outcome.smtpAttempts,
  }
}
