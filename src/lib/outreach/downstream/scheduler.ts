/**
 * Bounded downstream scheduler.
 *
 * One tick performs at most one external provider write. Effects are reserved
 * durably (stable logical key, independent of any browser UUID or config
 * version) before the call, so a crash, a duplicate canonical event or a
 * concurrent worker can never create a second effect. An uncertain provider
 * outcome is marked unknown and is never automatically retried.
 *
 * The decision consumer is the exact 021 outbox consumer declared by migration
 * 030; the 029/030 send loops are not re-implemented here.
 */
import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { authorizeDownstreamWrite } from './service'
import { decrypt } from '@/lib/encryption'
import type { OutreachEventV1 } from '@/lib/outreach/events'
import { WinnrApiError } from '@/lib/winnr/server'
import {
  DECISION_CONSUMER,
  DOWNSTREAM_LEASE_SECONDS,
  DownstreamError,
  type DownstreamTickResult,
} from './core'
import type { DownstreamWorkerDeps } from './runtime'

const decisionDataSchema = z.object({ decisionId: z.string().uuid(), sourceReplyId: z.string().uuid().optional() })

export function readDecisionId(event: OutreachEventV1): string | null {
  const parsed = decisionDataSchema.safeParse(event.data)
  return parsed.success ? parsed.data.decisionId : null
}

/** The canonical operation the decision is about; stable across re-decisions. */
export function readSourceReplyId(event: OutreachEventV1): string | null {
  const parsed = decisionDataSchema.safeParse(event.data)
  return parsed.success ? (parsed.data.sourceReplyId ?? null) : null
}

export function effectFingerprint(decisionId: string, effectKind: string): string {
  return createHash('sha256').update(`${decisionId}:${effectKind}`).digest('hex')
}

function extractSecret(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      const candidate = record.token ?? record.apiKey ?? record.accessToken ?? record.api_key
      if (typeof candidate === 'string' && candidate.length > 0) return candidate
    }
  } catch {
    // plain string secret
  }
  return raw
}

function providerDeadline(deadlineAt: number): AbortSignal {
  return AbortSignal.timeout(Math.max(1, Math.min(12_000, deadlineAt - Date.now())))
}

interface EffectSpec {
  kind: 'ghl_contact' | 'ghl_opportunity' | 'closebot_forward'
  provider: 'ghl' | 'closebot'
}

const EFFECT_SPECS: EffectSpec[] = [
  { kind: 'ghl_contact', provider: 'ghl' },
  { kind: 'ghl_opportunity', provider: 'ghl' },
  { kind: 'closebot_forward', provider: 'closebot' },
]

export interface ReserveDecisionEffectsResult {
  reserved: number
  /** Configured but disabled providers whose approved effect must not be lost. */
  pending: number
  /** Effects refused only because a prerequisite (e.g. qualification) is not yet
   * present; the decision must be retried rather than ACKed away. */
  deferred: number
}

/** Reserve every configured effect for one decision. No provider call here.
 * `sourceReplyId` is the canonical operation: the logical key is derived from
 * it, never from the decision/config/browser identity, so a re-decision for the
 * same reply cannot reserve a second effect while the first is unknown. */
export async function reserveDecisionEffects(
  organizationId: string,
  decisionId: string,
  sourceReplyId: string,
  deps: DownstreamWorkerDeps,
  deadlineAt: number,
): Promise<ReserveDecisionEffectsResult> {
  let reserved = 0
  let pending = 0
  let deferred = 0
  for (const spec of EFFECT_SPECS) {
    const secret = await deps.repository.connectionSecret(organizationId, spec.provider, deadlineAt)
    if (!secret.configured || secret.revision === undefined || !secret.credentialCiphertext) continue
    // A configured but disabled provider is a partial operation: keep the
    // approved decision outbox un-acked so enabling the provider can still
    // produce the effect instead of silently dropping it.
    if (!secret.enabled) {
      pending += 1
      continue
    }
    const result = await deps.repository.reserveEffect(
      organizationId,
      {
        provider: spec.provider,
        decisionId,
        effectKind: spec.kind,
        logicalKey: `operation:${sourceReplyId}:${spec.kind}`,
        payloadFingerprint: effectFingerprint(decisionId, spec.kind),
        connectionRevision: secret.revision,
      },
      deadlineAt,
    )
    if (result.allowed) {
      reserved += 1
    } else if (result.reason === 'contact_not_synced' || result.reason === 'not_qualified' || result.reason === 'connection_stale' || result.reason === 'provider_disabled') {
      // A deferred prerequisite (e.g. the CloseBot qualification) can arrive
      // later; hold the outbox so the configured opportunity is not lost.
      deferred += 1
    }
  }
  return { reserved, pending, deferred }
}

async function settle(
  deps: DownstreamWorkerDeps,
  organizationId: string,
  effectId: string,
  dispatchToken: string,
  status: 'succeeded' | 'unknown' | 'failed' | 'skipped',
  receipt: Record<string, unknown> | undefined,
  errorCode: string | undefined,
  deadlineAt: number,
  grant: Record<string, unknown> = {},
): Promise<void> {
  try {
    await deps.repository.settleEffect(organizationId, { ...grant, effectId, dispatchToken, status, receipt: receipt ?? null, errorCode: errorCode ?? null }, deadlineAt)
  } catch {
    // A settlement failure leaves the effect dispatching; the lease expiry holds
    // it as unknown for an operator. It is never silently marked succeeded.
  }
}

/** Execute exactly one claimed (fenced) effect. */
export async function executeReservedEffect(
  organizationId: string,
  effectId: string,
  dispatchToken: string,
  deps: DownstreamWorkerDeps,
  deadlineAt: number,
): Promise<void> {
  let grant: Record<string, unknown> = {}
  const context = await deps.repository.effectContext(organizationId, effectId, dispatchToken, deadlineAt)
  if (!context.found || !context.effect) return
  const kind = context.effect.effect_kind
  // Final transactional authorization: the exact reserved connection revision,
  // the current master stop and the canonical approval are re-checked at the
  // grant, so a config change between reserve and execute is rejected.
  if (context.connectionStale === true || context.connectionRevision !== context.effect.connection_revision) {
    await settle(deps, organizationId, effectId, dispatchToken, 'skipped', undefined, 'connection_stale', deadlineAt, grant)
    return
  }
  if (context.masterStop === true) {
    await settle(deps, organizationId, effectId, dispatchToken, 'skipped', undefined, 'master_stop', deadlineAt, grant)
    return
  }
  if (!context.connectionEnabled || !context.credentialCiphertext) {
    await settle(deps, organizationId, effectId, dispatchToken, 'skipped', undefined, 'connection_unavailable', deadlineAt, grant)
    return
  }
  if (kind === 'closebot_forward' && context.decision?.approved !== true) {
    await settle(deps, organizationId, effectId, dispatchToken, 'skipped', undefined, 'decision_not_approved', deadlineAt, grant)
    return
  }
  const raw = extractSecret(decrypt(context.credentialCiphertext))
  const config = context.config ?? {}
  const lead = context.lead ?? null
  const signal = providerDeadline(deadlineAt)
  const authorize = async (payload: Record<string, unknown>): Promise<boolean> => {
    const result = await authorizeDownstreamWrite(deps.repository, organizationId, { kind: 'effect', subjectId: effectId, dispatchToken, connectionRevision: context.effect?.connection_revision }, payload, deadlineAt)
    if (!result) return false
    grant = result
    return true
  }
  try {
    if (kind === 'ghl_contact') {
      const locationId = typeof config.locationId === 'string' ? config.locationId : ''
      if (!locationId || !lead?.email) throw new DownstreamError('config_incomplete', 'GHL location or lead email missing')
      const payload = { locationId, email: lead.email, source: 'coldforge-outreach', ...(lead.firstName ? { firstName: lead.firstName } : {}), ...(lead.lastName ? { lastName: lead.lastName } : {}), ...(lead.phone ? { phone: lead.phone } : {}) }
      if (!await authorize(payload)) return
      const result = await deps.ports.ghl.upsertContact(raw, payload, signal)
      if (lead.leadId) {
        await deps.repository.recordCrmLink(organizationId, {
          leadId: lead.leadId,
          externalContactId: result.contactId,
          locationId,
          data: { created: result.created },
        }, deadlineAt)
      }
      await settle(deps, organizationId, effectId, dispatchToken, 'succeeded', { contactId: result.contactId, created: result.created }, undefined, deadlineAt, grant)
      return
    }
    if (kind === 'ghl_opportunity') {
      const locationId = typeof config.locationId === 'string' ? config.locationId : ''
      const pipelineId = typeof config.pipelineId === 'string' ? config.pipelineId : ''
      if (!locationId || !pipelineId || !context.crmContactId || !lead?.email) {
        await settle(deps, organizationId, effectId, dispatchToken, 'skipped', undefined, 'contact_not_synced', deadlineAt, grant)
        return
      }
      const payload = { locationId, pipelineId, contactId: context.crmContactId, name: `${lead.firstName ?? ''} ${lead.lastName ?? ''}`.trim() || lead.email, status: 'open' as const }
      if (!await authorize(payload)) return
      const result = await deps.ports.ghl.upsertOpportunity(raw, payload, signal)
      await deps.repository.recordCrmLink(organizationId, { leadId: lead.leadId, externalContactId: context.crmContactId, externalOpportunityId: result.opportunityId, locationId }, deadlineAt)
      await settle(deps, organizationId, effectId, dispatchToken, 'succeeded', { opportunityId: result.opportunityId }, undefined, deadlineAt, grant)
      return
    }
    if (kind === 'closebot_forward') {
      const sourceId = typeof config.sourceId === 'string' ? config.sourceId : ''
      if (!sourceId) throw new DownstreamError('config_incomplete', 'CloseBot source id missing')
      // Only a ready canonical body is ever forwarded. A missing body stays
      // unknown rather than sending stale or partial content.
      if (!context.bodyReady || !context.replyBody) {
        await settle(deps, organizationId, effectId, dispatchToken, 'unknown', undefined, 'body_not_ready', deadlineAt, grant)
        return
      }
      const event = {
        contactId: lead?.leadId ?? null,
        body: context.replyBody,
        state: {
          coldforgeLeadId: lead?.leadId ?? null,
          decisionId: context.effect.decision_id,
          threadId: context.decision?.threadId ?? null,
          replyId: context.decision?.sourceReplyId ?? null,
        },
      }
      if (!await authorize({ sourceId, event })) return
      const result = await deps.ports.closebot.sendEvent(raw, sourceId, event, signal)
      await settle(deps, organizationId, effectId, dispatchToken, 'succeeded', { accepted: result.accepted, receipt: result.receipt }, undefined, deadlineAt, grant)
      return
    }
    await settle(deps, organizationId, effectId, dispatchToken, 'skipped', undefined, 'unsupported_effect', deadlineAt, grant)
  } catch (error) {
    if (error instanceof DownstreamError) {
      const status = error.retryable || error.code === 'aborted' ? 'unknown' : 'failed'
      await settle(deps, organizationId, effectId, dispatchToken, status, undefined, error.code, deadlineAt, grant)
      return
    }
    // Any unexpected error after the provider may have accepted the request is
    // unknown, never a fabricated success and never an automatic retry.
    await settle(deps, organizationId, effectId, dispatchToken, 'unknown', undefined, 'unexpected', deadlineAt, grant)
  }
}

export interface DownstreamTickOptions {
  deadlineAt?: number
}

export async function runDownstreamTick(
  deps: DownstreamWorkerDeps,
  options: DownstreamTickOptions = {},
): Promise<DownstreamTickResult> {
  const deadlineAt = options.deadlineAt ?? Date.now() + 25_000
  let org: { organizationId: string; actorId: string } | null
  try {
    org = await deps.repository.nextOrg(deadlineAt)
  } catch {
    return { result: 'error', reason: 'org_resolution_unavailable' }
  }
  if (!org) return { result: 'idle', reason: 'no_eligible_organization' }
  const organizationId = org.organizationId

  // Phase 1: claim at most one reserved effect under an exclusive fence and
  // perform at most one external write.
  let next
  try {
    next = await deps.repository.claimEffect(organizationId, DOWNSTREAM_LEASE_SECONDS, deadlineAt)
  } catch {
    return { result: 'error', organizationId, reason: 'effect_lookup_unavailable' }
  }
  if (next.effectId && next.dispatchToken) {
    try {
      await executeReservedEffect(organizationId, next.effectId, next.dispatchToken, deps, deadlineAt)
    } catch {
      // The dispatch fence and lease hold the effect for operator
      // reconciliation; it is never left eligible for an automatic resend.
      return { result: 'error', organizationId, effectId: next.effectId, reason: 'effect_execution_unavailable' }
    }
    return { result: 'effect_settled', organizationId, effectId: next.effectId, ...(next.effectKind ? { effectKind: next.effectKind } : {}) }
  }

  // Phase 2: claim one canonical decision job and durably reserve its effects.
  const leaseToken = randomUUID()
  let claimed
  try {
    claimed = await deps.events.claim({
      organizationId,
      consumer: DECISION_CONSUMER,
      leaseToken,
      leaseSeconds: DOWNSTREAM_LEASE_SECONDS,
      limit: 1,
      deadlineAt,
    })
  } catch {
    return { result: 'error', organizationId, reason: 'decision_claim_unavailable' }
  }
  const job = claimed.jobs[0]
  if (!job) return { result: 'idle', organizationId, reason: 'no_decision' }

  const fail = async (errorCode: string, retryable: boolean): Promise<void> => {
    try {
      await deps.events.fail({ organizationId, outboxId: job.outboxId, leaseToken, leaseExpiresAt: job.leaseExpiresAt, errorCode, retryable, deadlineAt })
    } catch {
      // The lease will expire and hold the job; never claim success.
    }
  }

  if (job.event.type !== 'conversation.decision.recorded' || job.event.source !== 'outreach.agents') {
    await fail('unexpected_decision_event', false)
    return { result: 'blocked', organizationId, reason: 'unexpected_decision_event' }
  }
  const decisionId = readDecisionId(job.event)
  if (!decisionId) {
    await fail('decision_id_missing', false)
    return { result: 'blocked', organizationId, reason: 'decision_id_missing' }
  }
  const sourceReplyId = readSourceReplyId(job.event)
  if (!sourceReplyId) {
    await fail('source_reply_missing', false)
    return { result: 'blocked', organizationId, reason: 'source_reply_missing' }
  }
  let reserved = 0
  let pending = 0
  let deferred = 0
  try {
    const outcome = await reserveDecisionEffects(organizationId, decisionId, sourceReplyId, deps, deadlineAt)
    reserved = outcome.reserved
    pending = outcome.pending
    deferred = outcome.deferred
  } catch {
    await fail('reservation_failed', true)
    return { result: 'held', organizationId, reason: 'reservation_failed' }
  }
  // A configured-but-disabled provider or a deferred prerequisite leaves an
  // approved operation pending. The decision is held (retryable) instead of
  // acked so it is never lost and can be completed once prerequisite/provider
  // readiness arrives.
  if (pending > 0 || deferred > 0) {
    await fail('operation_pending', true)
    return { result: 'held', organizationId, reason: 'operation_pending', reserved }
  }
  try {
    const acked = await deps.events.ack({ organizationId, outboxId: job.outboxId, leaseToken, leaseExpiresAt: job.leaseExpiresAt, deadlineAt })
    if (acked.result !== 'acked') return { result: 'held', organizationId, reason: `ack_${acked.result}` }
  } catch {
    return { result: 'held', organizationId, reason: 'ack_failed' }
  }
  return { result: 'reserved', organizationId, reserved }
}

// ---------------------------------------------------------------------------
// Requested callback initiation (owner-recorded eligibility required).
// ---------------------------------------------------------------------------
export interface CallbackInitiationResult {
  allowed: boolean
  reason?: string
  callbackId?: string
  providerCallId?: string
}

export async function initiateRequestedCallback(
  actor: { userId: string; organizationId: string; role: string },
  eligibilityId: string,
  deps: DownstreamWorkerDeps,
  deadlineAt = Date.now() + 20_000,
): Promise<CallbackInitiationResult> {
  if (!['owner', 'admin'].includes(actor.role)) throw new WinnrApiError(403, 'forbidden', 'Only owners and admins can request callbacks')
  const retell = await deps.repository.connectionSecret(actor.organizationId, 'retell', deadlineAt)
  if (!retell.configured || !retell.enabled || retell.revision === undefined || !retell.credentialCiphertext) {
    return { allowed: false, reason: 'provider_disabled' }
  }
  const config = retell.config ?? {}
  const fromNumber = typeof config.fromNumber === 'string' ? config.fromNumber : ''
  if (!fromNumber) return { allowed: false, reason: 'config_incomplete' }
  const reserved = await deps.repository.reserveCallback(
    actor.organizationId,
    { eligibilityId, connectionRevision: retell.revision, fromNumber },
    deadlineAt,
  )
  if (reserved.allowed !== true) return { allowed: false, reason: typeof reserved.reason === 'string' ? reserved.reason : 'not_eligible' }
  const callbackId = typeof reserved.callbackId === 'string' ? reserved.callbackId : undefined
  const phoneE164 = typeof reserved.phoneE164 === 'string' ? reserved.phoneE164 : ''
  if (!callbackId || !phoneE164) return { allowed: false, reason: 'reservation_invalid' }
  let raw: string
  try {
    raw = extractSecret(decrypt(retell.credentialCiphertext))
  } catch {
    await deps.repository.settleCallback(actor.organizationId, { callbackId, status: 'unknown', errorCode: 'credential_unreadable' }, deadlineAt)
    return { allowed: false, reason: 'credential_unreadable', callbackId }
  }
  const payload = { fromNumber, toNumber: phoneE164, idempotencyKey: callbackId, metadata: { callbackId, organizationId: actor.organizationId } }
  const grant = await authorizeDownstreamWrite(deps.repository, actor.organizationId, { kind: 'callback', subjectId: callbackId, actorId: actor.userId, connectionRevision: retell.revision }, payload, deadlineAt)
  if (!grant) return { allowed: false, reason: 'authorization_changed', callbackId }
  try {
    const result = await deps.ports.retell.createPhoneCall(
      raw,
      payload,
      providerDeadline(deadlineAt),
    )
    await deps.repository.settleCallback(
      actor.organizationId,
      { ...grant, callbackId, status: 'initiated', providerCallId: result.callId, receipt: result.receipt },
      deadlineAt,
    )
    return { allowed: true, callbackId, providerCallId: result.callId }
  } catch (error) {
    // The provider may have accepted the call. Hold it as unknown; never retry.
    const code = error instanceof DownstreamError ? error.code : 'unexpected'
    try {
      await deps.repository.settleCallback(actor.organizationId, { ...grant, callbackId, status: 'unknown', errorCode: code }, deadlineAt)
    } catch {
      // keep the reservation held
    }
    return { allowed: false, reason: code, callbackId }
  }
}
