/** Organization-scoped durable suppression contract from migration023. */
import { createSuppressionClient } from './suppression-database'
import { z } from 'zod'
/** Reasons accepted by migration023. */
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
  leadId?: string
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

/** Persist an organization-scoped suppression. Legacy workspaceId means organizationId; null is rejected. */
export async function recordSuppression(
  record: SuppressionRecord
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!record.workspaceId) return { success: false, error: 'Organization is required' }
    const supabase = createSuppressionClient()
    const { data, error } = await supabase.rpc('record_outreach_suppression', {
      p_organization_id: record.workspaceId, p_email: record.email, p_reason: record.reason,
      p_source: record.source ?? 'coldforge', p_notes: record.notes ?? null,
      p_original_event_id: record.originalEventId ?? null, p_expires_at: record.expiresAt?.toISOString() ?? null,
      p_lead_id: record.leadId ?? null,
    })
    return !error && data === true ? { success: true } : { success: false, error: 'Suppression persistence failed' }
  } catch { return { success: false, error: 'Suppression storage unavailable' } }
}

/** Tenant-scoped preflight lookup; durable dispatch must separately enforce the final send boundary. */
export async function isSuppressed(
  email: string,
  workspaceId: string
): Promise<EligibilityResult> {
  try {
  const supabase = createSuppressionClient()
  const nowIso = new Date().toISOString()

  const { data, error } = await supabase
    .from('outreach_suppressions')
    .select('reason, expires_at')
    .eq('normalized_email', normalizeEmail(email))
    .eq('organization_id', workspaceId)
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .limit(1)

  if (error) {
    // Fail closed. A suppression lookup that errors must never be read as
    // "not suppressed" — an unavailable lookup is never interpreted as permission.
    console.error('[suppression] lookup failed, failing closed', { code: error.code })
    return { eligible: false, reason: 'error', detail: 'suppression lookup failed' }
  }

  const hit = data?.[0]
  if (hit) {
    return {
      eligible: false,
      reason: suppressionReasonSchema.parse(hit.reason),
      detail: 'suppressed',
    }
  }

  return { eligible: true }
  } catch { return { eligible: false, reason: 'error', detail: 'suppression storage unavailable' } }
}

const suppressionReasonSchema = z.enum(['hard_bounce','soft_bounce','complaint','unsubscribe','spam_trap','invalid','role_based','manual'])

/** Whether a reason permanently stops commercial mail. */
export function isPermanentReason(reason: SuppressionReason): boolean {
  return PERMANENT_REASONS.has(reason)
}

/** Product policy: complaints and unusable addresses also block direct inbound replies. */
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

  const reason = suppressionReasonSchema.parse(result.reason)

  if (REPLY_BLOCKING_REASONS.has(reason)) {
    return { eligible: false, reason, detail: 'reply blocked by suppression' }
  }

  // Suppressed for a reason that does not bar conversation.
  return { eligible: true }
}
