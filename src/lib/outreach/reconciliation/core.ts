import type { EvidenceStatus, ReconciliationItem } from './schemas'

/**
 * Pure reconciliation policy helpers. No I/O, no provider calls: everything
 * here is deterministic and directly unit-testable.
 */

/**
 * Evidence is authoritative only when exactly one persisted mapping matches the
 * frozen message identity and the canonical account/recipient/sender. Zero is
 * missing; anything else (multiple mappings, mismatched recipient/account) is
 * conflicting and must stay held.
 */
export function classifyEvidence(totalCount: number, exactCount: number): EvidenceStatus {
  if (totalCount <= 0) return 'missing'
  if (totalCount === 1 && exactCount === 1) return 'available'
  return 'conflicting'
}

export function evidenceLabel(status: EvidenceStatus): string {
  switch (status) {
    case 'available':
      return 'Relay evidence available'
    case 'conflicting':
      return 'Conflicting relay evidence'
    default:
      return 'No relay evidence'
  }
}

export function canReconcile(item: Pick<ReconciliationItem, 'status' | 'evidence'>): boolean {
  return item.evidence === 'available' && item.status !== 'accepted'
}

export function formatAge(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return 'unknown age'
  const total = Math.floor(seconds)
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/**
 * Operator guidance for a held attempt. A missing receipt is never a reason to
 * resend or to release the hold manually: the operator must restore the
 * authenticated evidence channel first.
 */
export function heldGuidance(reason: string | null | undefined): string {
  switch (reason) {
    case 'evidence_missing':
      return 'No authenticated Winnr relay receipt matches this message. Check the Winnr webhook association for this connection, then run a manual inbox sync. Do not resend.'
    case 'evidence_conflicting':
      return 'Multiple or mismatched relay receipts reference this frozen message. Resolve the Winnr mapping conflict before reconciling. Do not resend.'
    case 'evidence_timestamp':
      return 'The relay receipt timestamp is not attributable to this attempt. Verify provider clock and receipt provenance before reconciling. Do not resend.'
    case 'fingerprint_mismatch':
      return 'This attempt changed since the page loaded. Reload the held list before reconciling.'
    case 'handoff_active':
      return 'The SMTP handoff is still live. Wait for its lease to expire before reconciling.'
    case 'pre_effect_reservation':
      return 'This reservation was never authorized, so it is not proof of a send. Discard it; do not reconcile.'
    case 'canonical_thread_unavailable':
      return 'The canonical conversation thread is unavailable, so the reply cannot be placed safely. Check the inbox thread state.'
    case 'not_proof_of_send':
      return 'This attempt was rejected or cancelled and is not proof of a send. Do not reconcile.'
    case 'not_found':
      return 'The attempt is not visible to this organization.'
    default:
      return 'This attempt is held. Reconciliation requires authenticated Winnr relay evidence for the exact frozen message. Do not resend.'
  }
}

/** The only fields a browser may contribute to a reconciliation request. */
export function buildReconcilePayload(request: { attemptId: string; fingerprint?: string }): Record<string, string> {
  return request.fingerprint === undefined
    ? { attemptId: request.attemptId }
    : { attemptId: request.attemptId, fingerprint: request.fingerprint }
}

export function heldCounts(items: ReconciliationItem[]): { available: number; conflicting: number; missing: number } {
  return {
    available: items.filter((item) => item.evidence === 'available').length,
    conflicting: items.filter((item) => item.evidence === 'conflicting').length,
    missing: items.filter((item) => item.evidence === 'missing').length,
  }
}
