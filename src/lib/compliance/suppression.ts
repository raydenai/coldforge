/**
 * Global suppression ledger (SEC-005) and pre-send eligibility (SEC-006, CAM-007).
 *
 * The `email_suppressions` table already existed (migration 010) and
 * `src/lib/smtp/queue.ts` already checked it before sending. Three gaps made
 * that insufficient:
 *
 *   1. The check was a bare SELECT taken before the send, so a suppression
 *      written between check and send was missed. That is a
 *      time-of-check/time-of-use gap on a legal control.
 *   2. Only the `email_queue` path consulted it. `src/lib/warmup/*`,
 *      `inbox/[id]/reply` and `replies/[id]/respond` call `sendEmail()` directly.
 *   3. Nothing ever wrote an `unsubscribe` reason, because no unsubscribe
 *      endpoint existed.
 *
 * This module is the single entry point for both directions: recording a
 * suppression, and asking whether a send may proceed.
 */

import { createAdminClient } from '@/lib/supabase/admin'

/** Reasons accepted by the email_suppressions CHECK constraint (migration 010). */
export type SuppressionReason =
  | 'hard_bounce'
  | 'soft_bounce'
  | 'complaint'
  | 'unsubscribe'
  | 'spam_trap'
  | 'invalid'
  | 'role_based'
  | 'manual'

/**
 * Reasons that permanently stop commercial mail. A soft bounce is temporary and
 * handled by retry policy, not by permanent suppression.
 */
const PERMANENT_REASONS: ReadonlySet<SuppressionReason> = new Set([
  'hard_bounce',
  'complaint',
  'unsubscribe',
  'spam_trap',
  'invalid',
  'role_based',
  'manual',
])

export interface SuppressionRecord {
  email: string
  workspaceId: string | null
  reason: SuppressionReason
  source?: string
  notes?: string
  originalEventId?: string
  /** Temporary suppressions only. Omit for permanent ones. */
  expiresAt?: Date
}

export interface EligibilityResult {
  eligible: boolean
  /** Present when `eligible` is false. */
  reason?: SuppressionReason | 'error'
  /** Safe for logs — carries no recipient content. */
  detail?: string
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * Record a suppression.
 *
 * `workspaceId: null` writes a GLOBAL suppression that stops mail for every
 * tenant. Unsubscribes and complaints are recorded against the workspace that
 * sent the mail; spam traps and hard bounces are candidates for global.
 *
 * Uses the admin client deliberately: a recipient actioning an unsubscribe is
 * unauthenticated, so RLS must be bypassed for this write. That is the whole
 * reason this lives behind a narrow module rather than being inlined.
 */
export async function recordSuppression(
  record: SuppressionRecord
): Promise<{ success: boolean; error?: string }> {
  const supabase = createAdminClient()
  const email = normalizeEmail(record.email)

  const { error } = await supabase.from('email_suppressions').upsert(
    {
      email,
      workspace_id: record.workspaceId,
      reason: record.reason,
      source: record.source ?? null,
      notes: record.notes ?? null,
      original_event_id: record.originalEventId ?? null,
      is_active: true,
      expires_at: record.expiresAt?.toISOString() ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'workspace_id,email' }
  )

  if (error) {
    // Never log the address itself.
    console.error('[suppression] failed to record', {
      reason: record.reason,
      workspaceId: record.workspaceId,
      code: error.code,
    })
    return { success: false, error: error.message }
  }

  return { success: true }
}

/**
 * Is this address suppressed for this tenant, right now?
 *
 * Matches a row that is either global (`workspace_id IS NULL`) or belongs to the
 * tenant, is active, and has not expired.
 *
 * This is the READ used for UI and pre-flight checks. It is NOT sufficient as
 * the final gate before a send — use `claimSendSlot()` for that.
 */
export async function isSuppressed(
  email: string,
  workspaceId: string
): Promise<EligibilityResult> {
  const supabase = createAdminClient()
  const nowIso = new Date().toISOString()

  const { data, error } = await supabase
    .from('email_suppressions')
    .select('reason, expires_at')
    .eq('email', normalizeEmail(email))
    .eq('is_active', true)
    .or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`)
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .limit(1)

  if (error) {
    // Fail closed. A suppression lookup that errors must never be read as
    // "not suppressed" — that is how a legal control silently becomes a no-op.
    console.error('[suppression] lookup failed, failing closed', { code: error.code })
    return { eligible: false, reason: 'error', detail: 'suppression lookup failed' }
  }

  const hit = data?.[0]
  if (hit) {
    return {
      eligible: false,
      reason: hit.reason as SuppressionReason,
      detail: 'suppressed',
    }
  }

  return { eligible: true }
}

/** Whether a reason permanently stops commercial mail. */
export function isPermanentReason(reason: SuppressionReason): boolean {
  return PERMANENT_REASONS.has(reason)
}

/**
 * Reasons that block even a direct 1:1 reply to an inbound message.
 *
 * This is deliberately NARROWER than the campaign gate, and the distinction is a
 * policy decision worth stating plainly:
 *
 *   - `complaint` / `spam_trap` — the recipient reported us. Sending anything
 *     further, including a reply, compounds the reputation and legal damage.
 *   - `hard_bounce` / `invalid` — the address does not accept mail. Retrying
 *     wastes reputation on a known-bad recipient.
 *   - `unsubscribe` is NOT here. An opt-out withdraws consent for *commercial*
 *     mail. If that person then writes to us, answering their own message is a
 *     transactional response they initiated, not a marketing touch. Refusing to
 *     answer a customer who emailed us would be poor service and is not required
 *     by CAN-SPAM.
 *   - `role_based` / `manual` / `soft_bounce` are campaign-targeting decisions,
 *     not conversation bans.
 *
 * If policy changes, change it here — every reply path reads this one set.
 */
const REPLY_BLOCKING_REASONS: ReadonlySet<SuppressionReason> = new Set([
  'complaint',
  'spam_trap',
  'hard_bounce',
  'invalid',
])

/**
 * May we send a direct reply to someone who contacted us?
 *
 * Fails CLOSED on lookup error, same as the campaign gate.
 */
export async function canReplyToInbound(
  email: string,
  workspaceId: string
): Promise<EligibilityResult> {
  const result = await isSuppressed(email, workspaceId)

  // Lookup error: refuse.
  if (result.reason === 'error') return result

  // Not suppressed at all.
  if (result.eligible) return result

  const reason = result.reason as SuppressionReason

  if (REPLY_BLOCKING_REASONS.has(reason)) {
    return { eligible: false, reason, detail: 'reply blocked by suppression' }
  }

  // Suppressed for a reason that does not bar conversation.
  return { eligible: true }
}
