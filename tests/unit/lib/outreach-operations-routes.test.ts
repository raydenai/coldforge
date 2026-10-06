import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { WinnrApiError } from '@/lib/winnr/server'

const cronBoundary = vi.hoisted(() => ({ ports: vi.fn(), run: vi.fn() }))
vi.mock('@/lib/outreach/operations/runtime', () => ({ createOperationsPorts: cronBoundary.ports }))
vi.mock('@/lib/outreach/operations/scheduler', () => ({ runOperationsTick: cronBoundary.run }))

const opsBoundary = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn(), control: vi.fn(), tick: vi.fn() }))
vi.mock('@/app/api/winnr/_shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/app/api/winnr/_shared')>()
  return { ...original, resolveAuthContext: opsBoundary.auth }
})
vi.mock('@/lib/outreach/operations/service', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/outreach/operations/service')>()
  return {
    ...original,
    readOperationsStatus: opsBoundary.read,
    controlOperations: opsBoundary.control,
    runManualOperationsTick: opsBoundary.tick,
  }
})

import { GET as cronGet } from '@/app/api/cron/outreach/route'
import { GET as operationsGet, POST as operationsPost } from '@/app/api/outreach/operations/route'

const ORG = '11111111-1111-4111-8111-111111111111'

function cronRequest(secret?: string, url = 'https://fixture.example/api/cron/outreach'): NextRequest {
  return new NextRequest(url, { method: 'GET', headers: secret ? { authorization: `Bearer ${secret}` } : {} })
}

function opsRequest(body: unknown, origin: string | null = 'https://fixture.example'): NextRequest {
  return new NextRequest('https://fixture.example/api/outreach/operations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  })
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe('cron outreach authentication', () => {
  it('returns 503 when the cron secret is not configured', async () => {
    vi.stubEnv('CRON_SECRET', '')
    const response = await cronGet(cronRequest('anything'))
    expect(response.status).toBe(503)
    expect(cronBoundary.run).not.toHaveBeenCalled()
  })

  it('returns 401 for a missing or wrong bearer', async () => {
    vi.stubEnv('CRON_SECRET', 'right-secret')
    expect((await cronGet(cronRequest())).status).toBe(401)
    expect((await cronGet(cronRequest('wrong-secret'))).status).toBe(401)
    expect(cronBoundary.run).not.toHaveBeenCalled()
  })

  it('runs the global tick with a correct secret and never honours query scope', async () => {
    vi.stubEnv('CRON_SECRET', 'right-secret')
    cronBoundary.ports.mockReturnValue({ marker: 'ports' })
    cronBoundary.run.mockResolvedValue({ result: 'idle', reason: 'no_eligible_organization' })
    const response = await cronGet(cronRequest('right-secret', 'https://fixture.example/api/cron/outreach?organizationId=foreign&actor=x&campaign=y'))
    expect(response.status).toBe(200)
    expect(cronBoundary.run).toHaveBeenCalledWith({ marker: 'ports' }, { deadlineAt: expect.any(Number) })
    await expect(response.json()).resolves.toEqual({ result: 'idle', reason: 'no_eligible_organization' })
  })

  it('accepts the x-cron-secret header as well', async () => {
    vi.stubEnv('CRON_SECRET', 'right-secret')
    cronBoundary.run.mockResolvedValue({ result: 'idle', reason: 'none' })
    const request = new NextRequest('https://fixture.example/api/cron/outreach', { method: 'GET', headers: { 'x-cron-secret': 'right-secret' } })
    expect((await cronGet(request)).status).toBe(200)
  })
})

describe('operations HTTP authority', () => {
  beforeEach(() => {
    opsBoundary.auth.mockResolvedValue({ userId: 'own-actor', organizationId: ORG, role: 'owner' })
    opsBoundary.read.mockResolvedValue({ status: { control: { revision: 1 } }, readiness: { ready: true } })
    opsBoundary.control.mockResolvedValue({ revision: 2, automationEnabled: true, schedulerPaused: false, masterStop: false })
    opsBoundary.tick.mockResolvedValue({ result: 'settled', phase: 'body' })
  })

  it('rejects unauthenticated reads before the service is called', async () => {
    opsBoundary.auth.mockRejectedValue(new WinnrApiError(401, 'unauthenticated', 'Authentication required'))
    expect((await operationsGet()).status).toBe(401)
    expect(opsBoundary.read).not.toHaveBeenCalled()
  })

  it('rejects members before the service is called', async () => {
    opsBoundary.auth.mockResolvedValue({ userId: 'member', organizationId: ORG, role: 'member' })
    expect((await operationsPost(opsRequest({ action: 'pause', expectedRevision: 1 }))).status).toBe(403)
    expect(opsBoundary.control).not.toHaveBeenCalled()
  })

  it('rejects a missing or foreign origin before any control runs', async () => {
    expect((await operationsPost(opsRequest({ action: 'stop', expectedRevision: 1 }, null))).status).toBe(403)
    expect((await operationsPost(opsRequest({ action: 'stop', expectedRevision: 1 }, 'https://foreign.example'))).status).toBe(403)
    expect(opsBoundary.control).not.toHaveBeenCalled()
  })

  it('forwards only the canonical actor, action and revision', async () => {
    const response = await operationsPost(opsRequest({ action: 'enable', expectedRevision: 7 }))
    expect(response.status).toBe(200)
    expect(opsBoundary.control).toHaveBeenCalledWith({ userId: 'own-actor', organizationId: ORG, role: 'owner' }, 'enable', 7, undefined, expect.any(Number))
  })

  it('rejects a body-selected organization via the strict schema', async () => {
    expect((await operationsPost(opsRequest({ action: 'pause', expectedRevision: 1, organizationId: 'foreign' }))).status).toBe(400)
    expect(opsBoundary.control).not.toHaveBeenCalled()
  })

  it('runs one manual tick and returns the refreshed view', async () => {
    const response = await operationsPost(opsRequest({ action: 'tick' }))
    expect(response.status).toBe(200)
    expect(opsBoundary.tick).toHaveBeenCalledWith({ userId: 'own-actor', organizationId: ORG, role: 'owner' }, undefined, expect.any(Number))
    expect(opsBoundary.control).not.toHaveBeenCalled()
    await expect(response.json()).resolves.toMatchObject({ tick: { result: 'settled', phase: 'body' } })
  })
})
