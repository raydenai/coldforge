import { describe, expect, it, vi } from 'vitest'
import { WinnrApiError } from '@/lib/winnr/server'
import type { OperationsReadiness, OperationsRepository, OperationsStatus } from '@/lib/outreach/operations/core'
import type { OperationsPorts } from '@/lib/outreach/operations/scheduler'
import {
  controlOperations,
  readOperationsStatus,
  requireOperationsManager,
  runManualOperationsTick,
  type OperationsServiceDeps,
} from '@/lib/outreach/operations/service'

const ORG = '11111111-1111-4111-8111-111111111111'
const actor = { userId: '22222222-2222-4222-8222-222222222222', organizationId: ORG, role: 'owner' as const }
const member = { ...actor, role: 'member' as const }

const status = { control: { revision: 3 } } as unknown as OperationsStatus
const notReady: OperationsReadiness = {
  ready: false,
  activeCampaigns: 0,
  configuredCampaigns: 0,
  blockers: [{ code: 'smtp_mailbox', label: 'Sync an SMTP mailbox', href: '/winnr' }],
}
const ready: OperationsReadiness = { ready: true, activeCampaigns: 1, configuredCampaigns: 1, blockers: [] }

function deps(overrides: { read?: unknown; readiness?: unknown; control?: unknown } = {}): OperationsServiceDeps {
  const repository = {
    claim: vi.fn(),
    settle: vi.fn(),
    read: vi.fn().mockResolvedValue(status),
    readiness: vi.fn().mockResolvedValue(ready),
    control: vi.fn().mockResolvedValue({ revision: 4, automationEnabled: true, schedulerPaused: false, masterStop: false }),
    ...overrides,
  } as unknown as OperationsRepository
  const ports = {
    repository,
    dispatch: vi.fn(),
    body: vi.fn(),
    decision: vi.fn(),
    reply: vi.fn(),
    now: () => 1,
  } as unknown as OperationsPorts
  return { repository, ports }
}

describe('operations service authority', () => {
  it('refuses a member', () => {
    expect(() => requireOperationsManager(member)).toThrow(WinnrApiError)
  })

  it('reads status and readiness together', async () => {
    const d = deps()
    await expect(readOperationsStatus(actor, d)).resolves.toEqual({ status, readiness: ready })
    expect(d.repository.read).toHaveBeenCalledWith(actor)
    expect(d.repository.readiness).toHaveBeenCalledWith(actor)
  })

  it('refuses to enable while setup blockers remain', async () => {
    const d = deps({ readiness: vi.fn().mockResolvedValue(notReady) })
    await expect(controlOperations(actor, 'enable', 1, d)).rejects.toMatchObject({ status: 409 })
    expect(d.repository.control).not.toHaveBeenCalled()
  })

  it('enables only through a readiness pass and a revision', async () => {
    const d = deps()
    await controlOperations(actor, 'enable', 3, d)
    expect(d.repository.control).toHaveBeenCalledWith(actor, 'enable', 3)
  })

  it('does not require readiness for pause/stop', async () => {
    const d = deps({ readiness: vi.fn().mockResolvedValue(notReady) })
    await controlOperations(actor, 'stop', 3, d)
    expect(d.repository.control).toHaveBeenCalledWith(actor, 'stop', 3)
  })

  it('rejects a non-current revision shape before storage', async () => {
    const d = deps()
    await expect(controlOperations(actor, 'pause', 0, d)).rejects.toMatchObject({ status: 400 })
    expect(d.repository.control).not.toHaveBeenCalled()
  })

  it('scopes a manual tick to the caller organization only', async () => {
    const d = deps()
    const claim = d.repository.claim as unknown as ReturnType<typeof vi.fn>
    claim.mockResolvedValue({ result: 'idle', reason: 'no_eligible_organization' })
    await runManualOperationsTick(actor, d)
    expect(claim).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG }))
  })
})
