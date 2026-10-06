/** Real HTTP handlers and service, with cookie storage and provider boundaries faked. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const boundary = vi.hoisted(() => ({
  getUser: vi.fn(), from: vi.fn(), select: vi.fn(), eq: vi.fn(), single: vi.fn(),
  repositoryFactory: vi.fn(), providerFactory: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({
  auth: { getUser: boundary.getUser }, from: boundary.from,
}) }))
vi.mock('@/lib/winnr/database', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/winnr/database')>(),
  createServiceRoleRepository: boundary.repositoryFactory,
}))
vi.mock('@/lib/winnr/client', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/winnr/client')>(),
  WinnrClient: boundary.providerFactory,
}))

import { GET as getConnection, POST as connect, DELETE as disconnect } from '@/app/api/winnr/connection/route'
import { GET as getWarming, POST as warming } from '@/app/api/winnr/warming/route'
import { GET as getMailboxes } from '@/app/api/winnr/mailboxes/route'
import { GET as getDomains } from '@/app/api/winnr/domains/route'
import { GET as getInbox } from '@/app/api/winnr/inbox/route'
import { WinnrError } from '@/lib/winnr/client'

const organizationId = '22222222-2222-4222-8222-222222222222'
const foreignOrganizationId = '33333333-3333-4333-8333-333333333333'
const connectionId = '44444444-4444-4444-8444-444444444444'
const operationId = '55555555-5555-4555-8555-555555555555'
const record = {
  id: connectionId, organizationId, version: 1, providerAccountId: 'account-1',
  accountName: 'Fixture account', accountPlan: null, permissions: ['read', 'write'],
  universalInboxEnabled: true, connectedAt: '2026-10-05T00:00:00Z', verifiedAt: '2026-10-05T00:00:00Z',
}
const repository = {
  getConnection: vi.fn(), getConnectionWithToken: vi.fn(), saveConnection: vi.fn(),
  deleteConnection: vi.fn(), reserveOperation: vi.fn(), settleOperation: vi.fn(),
}
const provider = {
  getAccount: vi.fn(), listMailboxes: vi.fn(), listDomains: vi.fn(), listInbox: vi.fn(),
  listWarming: vi.fn(), enableWarming: vi.fn(), pauseWarming: vi.fn(), resumeWarming: vi.fn(),
}
const mutation = { action: 'enable', connectionId, connectionVersion: 1, operationId, mailboxIds: ['mailbox-1'], confirmPaid: true }
function request(path: string, method = 'GET', body?: unknown, origin: string | null = 'https://review.example') {
  return new NextRequest(`https://review.example/api/winnr/${path}`, {
    method, headers: { ...(origin ? { origin } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden in route boundary tests'))
  boundary.getUser.mockResolvedValue({ data: { user: { id: 'authenticated-user' } } })
  boundary.from.mockReturnValue({ select: boundary.select })
  boundary.select.mockReturnValue({ eq: boundary.eq })
  boundary.eq.mockReturnValue({ single: boundary.single })
  boundary.single.mockResolvedValue({ data: { organization_id: organizationId, role: 'owner' } })
  boundary.repositoryFactory.mockReturnValue(repository)
  boundary.providerFactory.mockReturnValue(provider)
  repository.getConnection.mockResolvedValue(record)
  repository.getConnectionWithToken.mockResolvedValue({ connection: record, token: 'private-fixture-token' })
  repository.reserveOperation.mockResolvedValue({ result: 'reserved' })
  repository.settleOperation.mockResolvedValue(true)
  repository.saveConnection.mockResolvedValue({ result: 'saved', connectionId, version: 1 })
  repository.deleteConnection.mockResolvedValue({ result: 'deleted' })
  provider.getAccount.mockResolvedValue({ id: 'account-1', name: 'Fixture account', plan: null, permissions: ['read', 'write'], universalInboxEnabled: true })
  provider.enableWarming.mockResolvedValue([{ id: 'mailbox-1', email: 'fixture@example.invalid', status: 'connecting' }])
  for (const name of ['listMailboxes', 'listDomains', 'listInbox'] as const) provider[name].mockResolvedValue({ items: [], nextCursor: null, hasMore: false })
  provider.listWarming.mockResolvedValue({ items: [], page: 1, perPage: 10, total: 0, hasMore: false })
})
afterEach(() => vi.restoreAllMocks())

describe('Winnr HTTP authentication boundary', () => {
  it('rejects unauthenticated reads and writes before constructing privileged dependencies', async () => {
    boundary.getUser.mockResolvedValue({ data: { user: null } })
    const responses = [await getConnection(), await getMailboxes(request('mailboxes')), await getDomains(request('domains')),
      await getInbox(request('inbox')), await getWarming(request('warming')), await warming(request('warming', 'POST', mutation)),
      await connect(request('connection', 'POST', { token: 'fixture-token' })),
      await disconnect(request('connection', 'DELETE', { expectedConnectionId: connectionId, expectedVersion: 1 }))]
    for (const response of responses) expect(response.status).toBe(401)
    expect(boundary.from).not.toHaveBeenCalled()
    expect(boundary.repositoryFactory).not.toHaveBeenCalled()
    expect(boundary.providerFactory).not.toHaveBeenCalled()
  })

  it.each([null, { organization_id: null, role: 'owner' }, { organization_id: organizationId, role: 'superadmin' }])('fails closed on invalid membership %j', async membership => {
    boundary.single.mockResolvedValue({ data: membership })
    expect((await getConnection()).status).toBe(403)
    expect(boundary.repositoryFactory).not.toHaveBeenCalled()
  })

  it('resolves the tenant from the authenticated own users row and ignores body tenant/role', async () => {
    const response = await warming(request('warming', 'POST', { ...mutation, organizationId: foreignOrganizationId, role: 'owner', userId: 'other-user' }))
    expect(response.status).toBe(200)
    expect(boundary.from).toHaveBeenCalledWith('users')
    expect(boundary.select).toHaveBeenCalledWith('organization_id, role')
    expect(boundary.eq).toHaveBeenCalledWith('id', 'authenticated-user')
    expect(repository.getConnectionWithToken).toHaveBeenCalledWith(organizationId)
    expect(repository.reserveOperation).toHaveBeenCalledWith(expect.objectContaining({ organizationId }))
  })

  it('rejects member mutations even if the request body claims owner', async () => {
    boundary.single.mockResolvedValue({ data: { organization_id: organizationId, role: 'member' } })
    for (const response of [await warming(request('warming', 'POST', { ...mutation, role: 'owner' })),
      await connect(request('connection', 'POST', { token: 'fixture-token', role: 'owner' })),
      await disconnect(request('connection', 'DELETE', { expectedConnectionId: connectionId, expectedVersion: 1 }))]) expect(response.status).toBe(403)
    expect(boundary.providerFactory).not.toHaveBeenCalled()
    expect(repository.reserveOperation).not.toHaveBeenCalled()
    expect(repository.deleteConnection).not.toHaveBeenCalled()
  })

  it.each([null, 'https://foreign.example'])('rejects absent or foreign Origin %s before auth or provider construction', async origin => {
    for (const response of [await warming(request('warming', 'POST', mutation, origin)),
      await connect(request('connection', 'POST', { token: 'fixture-token' }, origin)),
      await disconnect(request('connection', 'DELETE', { expectedConnectionId: connectionId, expectedVersion: 1 }, origin))]) expect(response.status).toBe(403)
    expect(boundary.getUser).not.toHaveBeenCalled()
    expect(boundary.repositoryFactory).not.toHaveBeenCalled()
    expect(boundary.providerFactory).not.toHaveBeenCalled()
  })

  it('returns a same-origin receipt only after reservation, provider mutation and settlement, without token leakage', async () => {
    const response = await warming(request('warming', 'POST', mutation))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.operation).toEqual({ id: operationId, status: 'succeeded' })
    expect(JSON.stringify(body)).not.toMatch(/private-fixture-token|token_ciphertext/)
    expect(repository.reserveOperation.mock.invocationCallOrder[0]).toBeLessThan(provider.enableWarming.mock.invocationCallOrder[0])
    expect(provider.enableWarming.mock.invocationCallOrder[0]).toBeLessThan(repository.settleOperation.mock.invocationCallOrder[0])
  })

  it('returns a redacted connection envelope after token verification and encrypted storage', async () => {
    const response = await connect(request('connection', 'POST', { token: 'submitted-fixture-token' }))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual(expect.objectContaining({ canManage: true, connection: expect.objectContaining({ id: connectionId }) }))
    expect(JSON.stringify(body)).not.toMatch(/submitted-fixture-token|private-fixture-token|tokenCiphertext|token_ciphertext/)
    expect(repository.saveConnection).toHaveBeenCalledWith(expect.objectContaining({ organizationId, tokenCiphertext: expect.not.stringContaining('submitted-fixture-token') }))
    expect(provider.getAccount.mock.invocationCallOrder[0]).toBeLessThan(repository.saveConnection.mock.invocationCallOrder[0])
  })

  it('preserves uncertain provider outcome in the HTTP envelope and refuses a duplicate submission', async () => {
    provider.enableWarming.mockRejectedValue(new WinnrError('fixture timeout', { code: 'timeout', outcomeUnknown: true }))
    const first = await warming(request('warming', 'POST', mutation))
    expect(first.status).toBe(409)
    expect(await first.json()).toEqual({ error: expect.objectContaining({ code: 'outcome_unknown', outcomeUnknown: true, operationId }) })
    expect(repository.settleOperation).toHaveBeenCalledWith(expect.objectContaining({ organizationId, operationId, status: 'unknown' }))
    repository.reserveOperation.mockResolvedValue({ result: 'duplicate', status: 'unknown' })
    const duplicate = await warming(request('warming', 'POST', mutation))
    expect(duplicate.status).toBe(409)
    expect(provider.enableWarming).toHaveBeenCalledTimes(1)
  })

  it('rejects warming for a read-only connection before provider construction or reservation', async () => {
    repository.getConnectionWithToken.mockResolvedValue({ connection: { ...record, permissions: ['read'] }, token: 'private-fixture-token' })
    expect((await warming(request('warming', 'POST', mutation))).status).toBe(403)
    expect(boundary.providerFactory).not.toHaveBeenCalled()
    expect(repository.reserveOperation).not.toHaveBeenCalled()
  })

  it('rejects schema-invalid input with 400 before privileged dependency construction', async () => {
    for (const response of [await warming(request('warming', 'POST', { ...mutation, mailboxIds: [] })),
      await connect(request('connection', 'POST', { token: 'contains whitespace' })),
      await getMailboxes(request('mailboxes?limit=0')), await getInbox(request('inbox?limit=101'))]) expect(response.status).toBe(400)
    expect(boundary.repositoryFactory).not.toHaveBeenCalled()
    expect(boundary.providerFactory).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON as a client error before privileged dependency construction', async () => {
    const malformed = () => new NextRequest('https://review.example/api/winnr/warming', {
      method: 'POST', headers: { origin: 'https://review.example', 'content-type': 'application/json' }, body: '{',
    })
    for (const response of [await warming(malformed()), await connect(malformed())]) expect(response.status).toBe(400)
    expect(boundary.repositoryFactory).not.toHaveBeenCalled()
    expect(boundary.providerFactory).not.toHaveBeenCalled()
  })
})
