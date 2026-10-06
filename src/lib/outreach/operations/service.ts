import { WinnrApiError, type WinnrAuthContext } from '@/lib/winnr/server'
import {
  CONTROL_ACTIONS,
  type OperationsControlAction,
  type OperationsControlResult,
  type OperationsReadiness,
  type OperationsRepository,
  type OperationsStatus,
  type TickResult,
} from './core'
import { createOperationsRepository } from './database'
import { createOperationsPorts } from './runtime'
import { runOperationsTick, type OperationsPorts } from './scheduler'

export function requireOperationsManager(actor: WinnrAuthContext): void {
  if (!['owner', 'admin'].includes(actor.role)) {
    throw new WinnrApiError(403, 'forbidden', 'Only owners and admins can operate automation')
  }
}

export interface OperationsServiceDeps {
  repository: OperationsRepository
  ports: OperationsPorts
}

export function createOperationsServiceDeps(): OperationsServiceDeps {
  const repository = createOperationsRepository()
  return { repository, ports: createOperationsPorts(repository) }
}

export interface OperationsStatusView {
  status: OperationsStatus
  readiness: OperationsReadiness
}

/** Owner/admin status. A failed read is surfaced as unavailable, never as zero. */
export async function readOperationsStatus(
  actor: WinnrAuthContext,
  deps: OperationsServiceDeps = createOperationsServiceDeps(),
  deadlineAt?: number,
): Promise<OperationsStatusView> {
  requireOperationsManager(actor)
  const [status, readiness] = await Promise.all([
    deadlineAt === undefined ? deps.repository.read(actor) : deps.repository.read(actor, deadlineAt),
    deadlineAt === undefined ? deps.repository.readiness(actor) : deps.repository.readiness(actor, deadlineAt),
  ])
  return { status, readiness }
}

export async function controlOperations(
  actor: WinnrAuthContext,
  action: OperationsControlAction,
  expectedRevision: number,
  deps: OperationsServiceDeps = createOperationsServiceDeps(),
  deadlineAt?: number,
): Promise<OperationsControlResult> {
  requireOperationsManager(actor)
  if (!CONTROL_ACTIONS.includes(action)) throw new WinnrApiError(400, 'bad_request', 'Unsupported automation action')
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    throw new WinnrApiError(400, 'bad_request', 'A current automation revision is required')
  }
  if (action === 'enable') {
    const readiness = deadlineAt === undefined ? await deps.repository.readiness(actor) : await deps.repository.readiness(actor, deadlineAt)
    if (!readiness.ready) {
      const labels = readiness.blockers.map((blocker) => blocker.label).join(', ')
      throw new WinnrApiError(409, 'conflict', labels ? `Automation setup incomplete: ${labels}` : 'Automation setup is incomplete')
    }
  }
  return deadlineAt === undefined
    ? deps.repository.control(actor, action, expectedRevision)
    : deps.repository.control(actor, action, expectedRevision, deadlineAt)
}

/** A manual owner/admin tick runs exactly one phase for the caller's own org. */
export async function runManualOperationsTick(
  actor: WinnrAuthContext,
  deps: OperationsServiceDeps = createOperationsServiceDeps(),
  deadlineAt?: number,
): Promise<TickResult> {
  requireOperationsManager(actor)
  return runOperationsTick(deps.ports, { organizationId: actor.organizationId, ...(deadlineAt !== undefined ? { deadlineAt } : {}) })
}
