/**
 * Pre-send eligibility gate (SEC-006, CAM-004, CAM-007).
 *
 * Every send path must go through `claimSendSlot()` before handing a message to
 * a provider. There is no second door: `src/lib/warmup/*`,
 * `inbox/[id]/reply` and `replies/[id]/respond` previously called `sendEmail()`
 * with no suppression check at all.
 *
 * See supabase/migrations/019_send_eligibility.sql for what the atomicity does
 * and does not guarantee. Short version: check-and-claim is atomic, delivery is
 * at-least-once, and callers must still re-check immediately before handoff.
 */

import { createAdminClient } from '@/lib/supabase/admin'
import type { SuppressionReason } from './suppression'

export type ClaimRefusal =
  | SuppressionReason
  | 'duplicate'
  | 'invalid_email'
  | 'frequency_cap'
  | 'error'

/**
 * Default cross-campaign frequency cap.
 *
 * Counted per recipient per tenant across ALL campaigns, because a recipient
 * does not experience three campaigns as three relationships — they experience
 * one sender mailing them three times.
 */
export const DEFAULT_FREQUENCY_CAP = {
  maxPerWindow: 3,
  windowHours: 168, // 7 days
} as const

export interface ClaimResult {
  allowed: boolean
  reason?: ClaimRefusal
  idempotencyKey: string
}

/**
 * Deterministic idempotency key for a planned touch (CAM-004).
 *
 * Two workers planning the same touch must compute the same key, so a
 * redelivered job is refused by the unique index rather than sent twice.
 * `logicalAttempt` is the *planned* retry ordinal, not a wall-clock counter —
 * it must be derived from durable state, never from a local variable.
 */
export function buildTouchKey(input: {
  campaignId: string
  leadId: string
  stepVersion: number | string
  logicalAttempt: number
}): string {
  return [
    'campaign',
    input.campaignId,
    'lead',
    input.leadId,
    'step',
    String(input.stepVersion),
    'attempt',
    String(input.logicalAttempt),
  ].join(':')
}

/** Key shape for non-campaign sends (warmup, manual replies). */
export function buildAdHocKey(kind: 'warmup' | 'reply', id: string, discriminator: string): string {
  return `${kind}:${id}:${discriminator}`
}

/**
 * Atomically verify the recipient is not suppressed and claim the send slot.
 *
 * Fails CLOSED on any error. A gate that returns "allowed" when the database is
 * unreachable is not a gate.
 */
export async function claimSendSlot(input: {
  idempotencyKey: string
  email: string
  workspaceId: string
  campaignId?: string
  leadId?: string
  /** Cross-campaign cap. Pass `{ maxPerWindow: 0 }` to disable. */
  frequencyCap?: { maxPerWindow: number; windowHours?: number }
}): Promise<ClaimResult> {
  const supabase = createAdminClient()

  const cap = input.frequencyCap ?? DEFAULT_FREQUENCY_CAP

  const { data, error } = await supabase.rpc('claim_send_slot', {
    p_idempotency_key: input.idempotencyKey,
    p_email: input.email,
    p_workspace_id: input.workspaceId,
    p_campaign_id: input.campaignId ?? null,
    p_lead_id: input.leadId ?? null,
    p_max_per_window: cap.maxPerWindow,
    p_window_hours: cap.windowHours ?? DEFAULT_FREQUENCY_CAP.windowHours,
  })

  if (error) {
    console.error('[send-eligibility] claim failed, refusing send', {
      code: error.code,
      key: input.idempotencyKey,
    })
    return { allowed: false, reason: 'error', idempotencyKey: input.idempotencyKey }
  }

  const row = Array.isArray(data) ? data[0] : data

  if (!row || typeof row.allowed !== 'boolean') {
    console.error('[send-eligibility] unexpected claim response, refusing send', {
      key: input.idempotencyKey,
    })
    return { allowed: false, reason: 'error', idempotencyKey: input.idempotencyKey }
  }

  return {
    allowed: row.allowed,
    reason: row.allowed ? undefined : ((row.reason ?? 'error') as ClaimRefusal),
    idempotencyKey: input.idempotencyKey,
  }
}

/** Record that the provider accepted the message. */
export async function markDispatched(
  idempotencyKey: string,
  providerMessageId?: string
): Promise<boolean> {
  const supabase = createAdminClient()

  const { data, error } = await supabase.rpc('mark_send_dispatched', {
    p_idempotency_key: idempotencyKey,
    p_provider_message_id: providerMessageId ?? null,
  })

  if (error) {
    console.error('[send-eligibility] mark dispatched failed', { code: error.code })
    return false
  }

  return data === true
}

/**
 * Release a claim after a failed send so the touch can be retried.
 *
 * Without this, a transient SMTP error would permanently block the touch,
 * because the unique idempotency key would refuse every subsequent attempt.
 */
export async function releaseSendClaim(idempotencyKey: string): Promise<boolean> {
  const supabase = createAdminClient()

  const { data, error } = await supabase.rpc('release_send_claim', {
    p_idempotency_key: idempotencyKey,
  })

  if (error) {
    console.error('[send-eligibility] release failed', { code: error.code })
    return false
  }

  return data === true
}
