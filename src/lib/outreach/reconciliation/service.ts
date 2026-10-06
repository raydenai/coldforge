import { WinnrApiError, type WinnrAuthContext } from '@/lib/winnr/server'
import { buildReconcilePayload } from './core'
import { createReconciliationRepository, type ReconciliationRepository } from './database'
import {
  reconciliationListSchema,
  reconciliationOutcomeSchema,
  reconciliationQuerySchema,
  reconciliationRequestSchema,
  reconciliationStatusSchema,
  type ReconciliationList,
  type ReconciliationOutcome,
  type ReconciliationStatus,
} from './schemas'

export interface ReconciliationDeps {
  repository: ReconciliationRepository
}

/**
 * Reconciliation is an owner/admin operator action. The membership check runs
 * before any privileged repository is constructed.
 */
export function requireReconciliationManager(actor: WinnrAuthContext): void {
  if (!['owner', 'admin'].includes(actor.role)) {
    throw new WinnrApiError(403, 'forbidden', 'Owner or admin required')
  }
}

export function createReconciliationDeps(): ReconciliationDeps {
  return { repository: createReconciliationRepository() }
}

/**
 * GET path. A read failure propagates as an unavailable state; it is never
 * converted into an empty list or a fabricated zero count.
 */
export async function readReconciliationState(
  actor: WinnrAuthContext,
  rawQuery: unknown,
  deps?: ReconciliationDeps,
): Promise<ReconciliationList | ReconciliationStatus> {
  requireReconciliationManager(actor)
  const query = reconciliationQuerySchema.parse(rawQuery)
  const resolved = deps ?? createReconciliationDeps()
  if (query.attemptId) {
    const data = await resolved.repository.call(actor.userId, actor.organizationId, 'status', { attemptId: query.attemptId })
    return reconciliationStatusSchema.parse(data)
  }
  const data = await resolved.repository.call(actor.userId, actor.organizationId, 'list', {})
  return reconciliationListSchema.parse(data)
}

/**
 * POST path. The browser contributes exactly one attempt id and an optional
 * expected fingerprint. The RPC re-reads the persisted relay receipt; a held
 * result is a normal, explicit outcome rather than a thrown success.
 */
export async function reconcileDispatchAttempt(
  actor: WinnrAuthContext,
  raw: unknown,
  deps?: ReconciliationDeps,
): Promise<ReconciliationOutcome> {
  requireReconciliationManager(actor)
  const request = reconciliationRequestSchema.parse(raw)
  const resolved = deps ?? createReconciliationDeps()
  const data = await resolved.repository.call(actor.userId, actor.organizationId, 'reconcile', buildReconcilePayload(request))
  return reconciliationOutcomeSchema.parse(data)
}
