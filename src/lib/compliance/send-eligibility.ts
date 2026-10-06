/** Dispatch remains unavailable until the durable email-first sender is integrated. Pure touch-key helpers are retained. */
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
  // Historical migration019 is not installed on the canonical live schema.
  // No provider handoff may occur until a durable dispatch ledger is integrated.
  return { allowed: false, reason: 'error', idempotencyKey: input.idempotencyKey }
}
export async function markDispatched(idempotencyKey: string, providerMessageId?: string): Promise<boolean> { void idempotencyKey; void providerMessageId; return false }
export async function releaseSendClaim(idempotencyKey: string): Promise<boolean> { void idempotencyKey; return false }
