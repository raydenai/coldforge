import { z } from 'zod'
import { dispatchCampaign } from '@/lib/outreach/dispatch'
import { createEmailDispatchDeps } from '@/lib/outreach/dispatch-runtime'
import { createOutreachEventRepository } from '@/lib/outreach/event-database'
import { createOutreachEventService } from '@/lib/outreach/events'
import { createIngestionDeps, processWinnrIngestionReceipt } from '@/lib/outreach/ingestion-service'
import { executeNextApprovedAgentReply, processNextAgentDecision } from '@/lib/outreach/agents/worker'
import { WinnrApiError, type WinnrAuthContext } from '@/lib/winnr/server'
import type { PhaseOutcome } from './core'
import { createOperationsRepository } from './database'
import { createBodyPhasePort, type BodyConsumerDeps, type OperationsPorts } from './scheduler'

const dispatchOutcomeSchema = z.object({
  attemptId: z.string().optional(),
  enrollmentId: z.string().optional(),
  outcome: z.string().optional(),
  code: z.string().optional(),
  receipt: z
    .object({
      outcome: z.enum(['accepted', 'rejected', 'unknown']),
      code: z.string().optional(),
      messageId: z.string().optional(),
      recipient: z.string().optional(),
    })
    .optional(),
})
const dispatchResultSchema = z.object({ outcomes: z.array(dispatchOutcomeSchema) })

/** One campaign send attempt through the shared 024/029 dispatch pipeline. */
export function createDispatchPhasePort() {
  return async (actor: WinnrAuthContext, campaignId: string, deadlineAt?: number): Promise<PhaseOutcome> => {
    const deps = createEmailDispatchDeps(actor, deadlineAt)
    let result: unknown
    try {
      result = await dispatchCampaign(actor.userId, actor.organizationId, campaignId, 1, deps)
    } catch (error) {
      if (error instanceof WinnrApiError) {
        return { status: 'blocked', reason: error.code ?? 'dispatch_not_ready', modelCalls: 0, smtpAttempts: 0 }
      }
      throw error
    }
    const parsed = dispatchResultSchema.safeParse(result)
    if (!parsed.success) return { status: 'held', reason: 'dispatch_result_unverified', modelCalls: 0, smtpAttempts: 0 }
    const first = parsed.data.outcomes[0]
    if (!first) return { status: 'idle', reason: 'no_eligible_candidate', modelCalls: 0, smtpAttempts: 0 }
    const attempt = first.attemptId ? { attemptId: first.attemptId } : {}
    // A durable top-level unknown/error (for example a failed receipt
    // settlement after an accepted SMTP handoff) is authoritative over the
    // recoverable acceptance. It must stay held for operator reconciliation
    // and must never advance the success heartbeat.
    if (first.outcome === 'unknown' || first.outcome === 'error') {
      return { status: 'held', reason: first.code ?? first.receipt?.code ?? 'smtp_outcome_unknown', ...attempt, modelCalls: 0, smtpAttempts: 1 }
    }
    if (first.receipt?.outcome === 'accepted') {
      return { status: 'completed', reason: 'smtp_accepted', ...attempt, modelCalls: 0, smtpAttempts: 1 }
    }
    if (first.receipt?.outcome === 'unknown') {
      return { status: 'held', reason: first.receipt.code ?? first.code ?? 'smtp_outcome_unknown', ...attempt, modelCalls: 0, smtpAttempts: 1 }
    }
    if (first.receipt?.outcome === 'rejected') {
      return { status: 'blocked', reason: first.receipt.code ?? 'smtp_rejected', ...attempt, modelCalls: 0, smtpAttempts: 1 }
    }
    return { status: 'blocked', reason: first.code ?? 'dispatch_not_reserved', modelCalls: 0, smtpAttempts: 0 }
  }
}

export function createBodyConsumerDeps(): BodyConsumerDeps {
  return {
    events: createOutreachEventService({ repository: createOutreachEventRepository() }),
    hydrate: (actor, receiptId, deadlineAt) => processWinnrIngestionReceipt(actor, receiptId, createIngestionDeps(deadlineAt), deadlineAt),
  }
}

/** One agent classification/model decision, never SMTP. */
export function createDecisionPhasePort() {
  return async (actor: WinnrAuthContext, deadlineAt?:number): Promise<PhaseOutcome> => {
    const result = await processNextAgentDecision(actor,undefined,deadlineAt)
    return {
      status: result.status,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.threadId ? { referenceId: result.threadId } : {}),
      ...(result.decisionId ? { decisionId: result.decisionId } : {}),
      modelCalls: result.modelCalls,
      smtpAttempts: result.smtpAttempts,
    }
  }
}

/** One approved agent reply through the shared 029 send gate, never a model call. */
export function createReplyPhasePort() {
  return async (actor: WinnrAuthContext, deadlineAt?:number): Promise<PhaseOutcome> => {
    const result = await executeNextApprovedAgentReply(actor,undefined,deadlineAt)
    return {
      status: result.status,
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.threadId ? { referenceId: result.threadId } : {}),
      ...(result.decisionId ? { decisionId: result.decisionId } : {}),
      ...(result.attemptId ? { attemptId: result.attemptId } : {}),
      modelCalls: result.modelCalls,
      smtpAttempts: result.smtpAttempts,
    }
  }
}

export function createOperationsPorts(repository = createOperationsRepository()): OperationsPorts {
  return {
    repository,
    dispatch: createDispatchPhasePort(),
    body: createBodyPhasePort(createBodyConsumerDeps()),
    decision: createDecisionPhasePort(),
    reply: createReplyPhasePort(),
    now: () => Date.now(),
  }
}
