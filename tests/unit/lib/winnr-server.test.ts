/**
 * Unit tests for the organization-scoped Winnr server service.
 *
 * These tests use fakes only: no live provider, no database, no keys. They
 * prove authorization, cross-tenant scoping, encryption-before-store, stale
 * connection rejection, operation idempotency/blocking, uncertain-outcome
 * settling, exact provider call counts and response redaction.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WinnrError, type WinnrClient } from '@/lib/winnr/client'
import { decrypt } from '@/lib/encryption'
import {
  WinnrApiError,
  connectAccount,
  disconnectAccount,
  getConnectionEnvelope,
  listDomains,
  listInbox,
  listMailboxes,
  listWarming,
  mutateWarming,
  CONSERVATIVE_WARMING_SETTINGS,
  type OperationStatus,
  type WinnrAuthContext,
  type WinnrConnectionRecord,
  type WinnrRepository,
  type WinnrServiceDeps,
} from '@/lib/winnr/server'

const OWNER: WinnrAuthContext = { userId: 'u1', organizationId: 'org-a', role: 'owner' }
const MEMBER: WinnrAuthContext = { userId: 'u2', organizationId: 'org-a', role: 'member' }

const TOKEN = 'winnr-token-abc123'
const ACCOUNT = {
  id: 'acct-1',
  name: 'Acme',
  plan: 'Startup',
  permissions: ['read', 'write'],
  universalInboxEnabled: true,
}

function connection(overrides: Partial<WinnrConnectionRecord> = {}): WinnrConnectionRecord {
  return {
    id: 'conn-1',
    organizationId: 'org-a',
    version: 3,
    providerAccountId: ACCOUNT.id,
    accountName: ACCOUNT.name,
    accountPlan: ACCOUNT.plan,
    permissions: ACCOUNT.permissions,
    universalInboxEnabled: ACCOUNT.universalInboxEnabled,
    connectedAt: '2026-10-05T00:00:00.000Z',
    verifiedAt: '2026-10-05T00:00:00.000Z',
    ...overrides,
  }
}

interface StoredOperation {
  organizationId: string
  connectionId: string
  fingerprint: string
  status: OperationStatus
  mailboxIds: string[]
  errorCode: string | null
}

class FakeRepository implements WinnrRepository {
  connections = new Map<string, WinnrConnectionRecord>()
  tokens = new Map<string, string>()
  operations = new Map<string, StoredOperation>()
  calls = { getConnection: 0, getConnectionWithToken: 0, save: 0, delete: 0, reserve: 0, settle: 0 }
  reserveOverride: ((input: Parameters<WinnrRepository['reserveOperation']>[0]) => ReturnType<WinnrRepository['reserveOperation']>) | null = null
  settleResult = true

  async getConnection(organizationId: string): Promise<WinnrConnectionRecord | null> {
    this.calls.getConnection += 1
    return this.connections.get(organizationId) ?? null
  }

  async getConnectionWithToken(organizationId: string): Promise<{ connection: WinnrConnectionRecord; token: string } | null> {
    this.calls.getConnectionWithToken += 1
    const conn = this.connections.get(organizationId)
    if (!conn) return null
    return { connection: conn, token: this.tokens.get(organizationId) ?? '' }
  }

  async saveConnection(input: Parameters<WinnrRepository['saveConnection']>[0]): ReturnType<WinnrRepository['saveConnection']> {
    this.calls.save += 1
    const existing = this.connections.get(input.organizationId)
    if (existing) {
      if (input.expectedConnectionId !== existing.id || input.expectedVersion !== existing.version) {
        return { result: 'stale' }
      }
    } else if (input.expectedConnectionId !== null || input.expectedVersion !== null) {
      return { result: 'stale' }
    }
    const id = existing?.id ?? 'conn-new'
    const version = (existing?.version ?? 0) + 1
    this.connections.set(input.organizationId, connection({
      id,
      organizationId: input.organizationId,
      version,
      providerAccountId: input.providerAccountId,
      accountName: input.accountName,
      accountPlan: input.accountPlan,
      permissions: input.permissions,
      universalInboxEnabled: input.universalInboxEnabled,
    }))
    this.tokens.set(input.organizationId, input.tokenCiphertext)
    return { result: 'saved', connectionId: id, version }
  }

  async deleteConnection(input: Parameters<WinnrRepository['deleteConnection']>[0]): ReturnType<WinnrRepository['deleteConnection']> {
    this.calls.delete += 1
    const existing = this.connections.get(input.organizationId)
    if (!existing) return { result: 'not_found' }
    if (existing.id !== input.expectedConnectionId || existing.version !== input.expectedVersion) {
      return { result: 'stale' }
    }
    const pending = [...this.operations.values()].some(
      (op) => op.organizationId === input.organizationId && (op.status === 'pending' || op.status === 'unknown')
    )
    if (pending) return { result: 'blocked' }
    this.connections.delete(input.organizationId)
    this.tokens.delete(input.organizationId)
    return { result: 'deleted' }
  }

  async reserveOperation(input: Parameters<WinnrRepository['reserveOperation']>[0]): ReturnType<WinnrRepository['reserveOperation']> {
    this.calls.reserve += 1
    if (this.reserveOverride) return this.reserveOverride(input)
    const conn = this.connections.get(input.organizationId)
    if (!conn) return { result: 'not_found' }
    if (conn.id !== input.connectionId || conn.version !== input.connectionVersion) return { result: 'stale' }
    const existing = this.operations.get(input.operationId)
    if (existing) {
      if (existing.fingerprint !== input.fingerprint) return { result: 'fingerprint_mismatch' }
      return { result: 'duplicate', status: existing.status }
    }
    const blocked = [...this.operations.entries()].find(([, op]) =>
      op.organizationId === input.organizationId &&
      (op.status === 'pending' || op.status === 'unknown') &&
      op.mailboxIds.some((id) => input.mailboxIds.includes(id))
    )
    if (blocked) return { result: 'blocked', status: blocked[1].status, operationId: blocked[0] }
    this.operations.set(input.operationId, {
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      fingerprint: input.fingerprint,
      status: 'pending',
      mailboxIds: input.mailboxIds,
      errorCode: null,
    })
    return { result: 'reserved' }
  }

  async settleOperation(input: Parameters<WinnrRepository['settleOperation']>[0]): ReturnType<WinnrRepository['settleOperation']> {
    this.calls.settle += 1
    if (!this.settleResult) return false
    const op = this.operations.get(input.operationId)
    if (!op || op.status !== 'pending') return false
    op.status = input.status
    op.errorCode = input.errorCode
    return true
  }
}

function makeProvider(overrides: Partial<WinnrClient> = {}): WinnrClient {
  return {
    getAccount: vi.fn(async () => ACCOUNT),
    listMailboxes: vi.fn(async () => ({ items: [], nextCursor: null, hasMore: false })),
    listDomains: vi.fn(async () => ({ items: [], nextCursor: null, hasMore: false })),
    listWarming: vi.fn(async () => ({ items: [], page: 1, perPage: 20, total: 0, hasMore: false })),
    getWarmingMetrics: vi.fn(async () => []),
    enableWarming: vi.fn(async () => []),
    pauseWarming: vi.fn(async () => undefined),
    resumeWarming: vi.fn(async () => undefined),
    disableWarming: vi.fn(async () => undefined),
    listInbox: vi.fn(async () => ({ items: [], nextCursor: null, hasMore: false })),
    sendMessage: vi.fn(async () => ({ messageId: 'm1' })),
    ...overrides,
  }
}

interface Harness {
  repository: FakeRepository
  provider: WinnrClient
  deps: WinnrServiceDeps
}

function harness(providerOverrides: Partial<WinnrClient> = {}): Harness {
  const repository = new FakeRepository()
  const provider = makeProvider(providerOverrides)
  const deps: WinnrServiceDeps = {
    repository,
    createProvider: () => provider,
    now: () => new Date('2026-10-05T12:00:00.000Z'),
  }
  return { repository, provider, deps }
}

function seedConnection(h: Harness, ctx: WinnrAuthContext = OWNER): void {
  h.repository.connections.set(ctx.organizationId, connection({ organizationId: ctx.organizationId }))
  h.repository.tokens.set(ctx.organizationId, 'ciphertext-placeholder')
}

function mutation(overrides: Partial<Parameters<typeof mutateWarming>[2]> = {}) {
  return {
    action: 'enable' as const,
    connectionId: 'conn-1',
    connectionVersion: 3,
    operationId: '11111111-1111-4111-8111-111111111111',
    mailboxIds: ['mb-1'],
    confirmPaid: true,
    ...overrides,
  }
}

beforeEach(() => {
  process.env.ENCRYPTION_SECRET = 'test-secret-value'
  process.env.ENCRYPTION_SALT = 'test-salt-value'
})

afterEach(() => {
  delete process.env.ENCRYPTION_SECRET
  delete process.env.ENCRYPTION_SALT
})

describe('connection envelope', () => {
  it('returns null plus canManage when no connection exists, and never mutates', async () => {
    const h = harness()
    const envelope = await getConnectionEnvelope(OWNER, h.deps)
    expect(envelope).toEqual({ connection: null, canManage: true })
    expect(h.repository.calls.reserve).toBe(0)
    expect(h.repository.calls.save).toBe(0)
    expect(h.repository.calls.delete).toBe(0)
  })

  it('redacts token and ciphertext from the response and reports canManage false for members', async () => {
    const h = harness()
    seedConnection(h)
    const envelope = await getConnectionEnvelope(MEMBER, h.deps)
    expect(envelope.canManage).toBe(false)
    expect(envelope.connection).toEqual({
      id: 'conn-1',
      version: 3,
      account: ACCOUNT,
      connectedAt: '2026-10-05T00:00:00.000Z',
      verifiedAt: '2026-10-05T00:00:00.000Z',
    })
    const serialized = JSON.stringify(envelope)
    expect(serialized).not.toContain('ciphertext')
    expect(serialized).not.toContain(TOKEN)
  })

  it('scopes reads to the caller organization', async () => {
    const h = harness()
    seedConnection(h, OWNER)
    const other: WinnrAuthContext = { userId: 'u9', organizationId: 'org-b', role: 'owner' }
    const envelope = await getConnectionEnvelope(other, h.deps)
    expect(envelope.connection).toBeNull()
  })
})

describe('connectAccount', () => {
  it('rejects members before contacting the provider', async () => {
    const h = harness()
    await expect(
      connectAccount(MEMBER, h.deps, { token: TOKEN, expectedConnectionId: null, expectedVersion: null })
    ).rejects.toMatchObject({ code: 'forbidden', status: 403 })
    expect(h.provider.getAccount).not.toHaveBeenCalled()
    expect(h.repository.calls.save).toBe(0)
  })

  it('verifies the token, encrypts it before storage and returns only safe fields', async () => {
    const h = harness()
    const envelope = await connectAccount(OWNER, h.deps, {
      token: TOKEN,
      expectedConnectionId: null,
      expectedVersion: null,
    })
    expect(h.provider.getAccount).toHaveBeenCalledTimes(1)
    const stored = h.repository.tokens.get('org-a')
    expect(stored).toBeDefined()
    expect(stored).not.toBe(TOKEN)
    expect(decrypt(stored as string)).toBe(TOKEN)
    expect(h.repository.calls.save).toBe(1)
    expect(envelope.connection?.account).toEqual(ACCOUNT)
    expect(JSON.stringify(envelope)).not.toContain(TOKEN)
  })

  it('never enables warm-up during connect', async () => {
    const h = harness()
    await connectAccount(OWNER, h.deps, { token: TOKEN, expectedConnectionId: null, expectedVersion: null })
    expect(h.provider.enableWarming).not.toHaveBeenCalled()
  })

  it('surfaces provider verification failures without echoing the token', async () => {
    const h = harness({
      getAccount: vi.fn(async () => {
        throw new WinnrError('bad token', { status: 401, code: 'unauthorized', outcomeUnknown: false })
      }),
    })
    const error = await connectAccount(OWNER, h.deps, {
      token: TOKEN,
      expectedConnectionId: null,
      expectedVersion: null,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(WinnrApiError)
    expect((error as WinnrApiError).status).toBe(502)
    expect(JSON.stringify((error as WinnrApiError).toBody())).not.toContain(TOKEN)
    expect(h.repository.calls.save).toBe(0)
  })
})

describe('disconnectAccount', () => {
  it('blocks disconnect while a pending/unknown operation exists', async () => {
    const h = harness()
    seedConnection(h)
    h.repository.operations.set('op-held', {
      organizationId: 'org-a',
      connectionId: 'conn-1',
      fingerprint: 'f',
      status: 'unknown',
      mailboxIds: ['mb-1'],
      errorCode: 'outcome_unknown',
    })
    await expect(
      disconnectAccount(OWNER, h.deps, { expectedConnectionId: 'conn-1', expectedVersion: 3 })
    ).rejects.toMatchObject({ code: 'operation_pending', status: 409 })
  })

  it('is owner/admin only', async () => {
    const h = harness()
    seedConnection(h)
    await expect(
      disconnectAccount(MEMBER, h.deps, { expectedConnectionId: 'conn-1', expectedVersion: 3 })
    ).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('read endpoints', () => {
  it('requires a connection', async () => {
    const h = harness()
    await expect(listMailboxes(OWNER, h.deps, {})).rejects.toMatchObject({ code: 'not_connected', status: 409 })
  })

  it('returns normalized page fields plus observation metadata', async () => {
    const h = harness({
      listMailboxes: vi.fn(async () => ({
        items: [{ id: 'mb-1', email: 'a@b.co', name: null, status: 'active' as const, dailyLimit: 10 }],
        nextCursor: 'c2',
        hasMore: true,
      })),
    })
    seedConnection(h)
    const page = await listMailboxes(MEMBER, h.deps, { limit: 25 })
    expect(page.items).toHaveLength(1)
    expect(page.nextCursor).toBe('c2')
    expect(page.hasMore).toBe(true)
    expect(page.connectionId).toBe('conn-1')
    expect(page.connectionVersion).toBe(3)
    expect(page.observedAt).toBe('2026-10-05T12:00:00.000Z')
    expect(h.repository.calls.reserve).toBe(0)
  })

  it('passes validated cursor/limit and warming page params through', async () => {
    const h = harness()
    seedConnection(h)
    await listDomains(OWNER, h.deps, { cursor: 'c1', limit: 5 })
    expect(h.provider.listDomains).toHaveBeenCalledWith({ cursor: 'c1', limit: 5 })
    await listWarming(OWNER, h.deps, { page: 2, perPage: 10 })
    expect(h.provider.listWarming).toHaveBeenCalledWith({ page: 2, perPage: 10 })
    await listInbox(OWNER, h.deps, { mailboxId: 'mb-1', cursor: 'c1', limit: 5 })
    expect(h.provider.listInbox).toHaveBeenCalledWith({ mailboxId: 'mb-1', cursor: 'c1', limit: 5 })
  })
})

describe('mutateWarming', () => {
  it('fails closed before reservation when the saved token has no write scope', async () => {
    const h = harness()
    seedConnection(h)
    h.repository.connections.set(OWNER.organizationId, connection({ permissions: ['read'] }))
    await expect(mutateWarming(OWNER, h.deps, mutation())).rejects.toMatchObject({ code: 'forbidden' })
    expect(h.repository.calls.reserve).toBe(0)
    expect(h.provider.enableWarming).not.toHaveBeenCalled()
  })

  it('records a held result if constructing the provider fails after reservation', async () => {
    const h = harness()
    seedConnection(h)
    h.deps.createProvider = () => { throw new Error('fixture constructor failure') }
    await expect(mutateWarming(OWNER, h.deps, mutation())).rejects.toMatchObject({ outcomeUnknown: true })
    expect(h.repository.operations.get(mutation().operationId)?.status).toBe('unknown')
  })
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects members without calling reserve or the provider', async () => {
    const h = harness()
    seedConnection(h)
    await expect(mutateWarming(MEMBER, h.deps, mutation())).rejects.toMatchObject({ code: 'forbidden' })
    expect(h.repository.calls.reserve).toBe(0)
    expect(h.provider.enableWarming).not.toHaveBeenCalled()
  })

  it('requires explicit paid confirmation for enable', async () => {
    const h = harness()
    seedConnection(h)
    await expect(mutateWarming(OWNER, h.deps, mutation({ confirmPaid: false }))).rejects.toMatchObject({
      code: 'bad_request',
    })
    expect(h.provider.enableWarming).not.toHaveBeenCalled()
  })

  it('rejects empty, multi-mailbox and unsafe mailbox ids', async () => {
    const h = harness()
    seedConnection(h)
    await expect(mutateWarming(OWNER, h.deps, mutation({ mailboxIds: [] }))).rejects.toMatchObject({ code: 'bad_request' })
    await expect(mutateWarming(OWNER, h.deps, mutation({ mailboxIds: ['a', 'b'] }))).rejects.toMatchObject({ code: 'bad_request' })
    await expect(mutateWarming(OWNER, h.deps, mutation({ mailboxIds: ['../etc'] }))).rejects.toMatchObject({ code: 'bad_request' })
    expect(h.provider.enableWarming).not.toHaveBeenCalled()
  })

  it('reserves before mutating and settles succeeded with conservative settings', async () => {
    const h = harness()
    seedConnection(h)
    const order: string[] = []
    const origReserve = h.repository.reserveOperation.bind(h.repository)
    h.repository.reserveOperation = vi.fn(async (input) => {
      order.push('reserve')
      return origReserve(input)
    })
    ;(h.provider.enableWarming as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      order.push('provider')
      return []
    })
    const result = await mutateWarming(OWNER, h.deps, mutation())
    expect(order).toEqual(['reserve', 'provider'])
    expect(h.provider.enableWarming).toHaveBeenCalledTimes(1)
    expect(h.provider.enableWarming).toHaveBeenCalledWith(['mb-1'], CONSERVATIVE_WARMING_SETTINGS)
    expect(h.repository.operations.get(mutation().operationId)?.status).toBe('succeeded')
    expect(result.operation).toEqual({ id: mutation().operationId, status: 'succeeded' })
    expect(result.observedAt).toBe('2026-10-05T12:00:00.000Z')
  })

  it('blocks replayed duplicate operations without calling the provider twice', async () => {
    const h = harness()
    seedConnection(h)
    const first = await mutateWarming(OWNER, h.deps, mutation())
    expect(first.operation.status).toBe('succeeded')
    const error = await mutateWarming(OWNER, h.deps, mutation()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(WinnrApiError)
    expect((error as WinnrApiError).status).toBe(409)
    expect(h.provider.enableWarming).toHaveBeenCalledTimes(1)
  })

  it('blocks a different operation id on the same mailbox while an unknown outcome is held', async () => {
    const h = harness()
    seedConnection(h)
    h.repository.operations.set('held-op', {
      organizationId: 'org-a',
      connectionId: 'conn-1',
      fingerprint: 'other',
      status: 'unknown',
      mailboxIds: ['mb-1'],
      errorCode: 'outcome_unknown',
    })
    const error = await mutateWarming(OWNER, h.deps, mutation()).catch((e: unknown) => e)
    expect((error as WinnrApiError).status).toBe(409)
    expect((error as WinnrApiError).outcomeUnknown).toBe(true)
    expect(h.provider.enableWarming).not.toHaveBeenCalled()
  })

  it('rejects a stale connection version before reserving', async () => {
    const h = harness()
    seedConnection(h)
    await expect(mutateWarming(OWNER, h.deps, mutation({ connectionVersion: 2 }))).rejects.toMatchObject({
      code: 'stale_connection',
      status: 409,
    })
    expect(h.repository.calls.reserve).toBe(0)
    expect(h.provider.enableWarming).not.toHaveBeenCalled()
  })

  it('settles rejected on a known provider rejection', async () => {
    const h = harness({
      enableWarming: vi.fn(async () => {
        throw new WinnrError('rejected', { status: 400, code: 'rejected', outcomeUnknown: false })
      }),
    })
    seedConnection(h)
    const error = await mutateWarming(OWNER, h.deps, mutation()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(WinnrApiError)
    expect((error as WinnrApiError).outcomeUnknown).toBe(false)
    expect((error as WinnrApiError).status).toBe(400)
    expect(h.repository.operations.get(mutation().operationId)?.status).toBe('rejected')
    expect(h.provider.enableWarming).toHaveBeenCalledTimes(1)
  })

  it('settles unknown on timeout/uncertain provider failure and never retries', async () => {
    const h = harness({
      enableWarming: vi.fn(async () => {
        throw new WinnrError('timed out', { status: 0, code: 'timeout', outcomeUnknown: true })
      }),
    })
    seedConnection(h)
    const error = await mutateWarming(OWNER, h.deps, mutation()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(WinnrApiError)
    expect((error as WinnrApiError).outcomeUnknown).toBe(true)
    expect((error as WinnrApiError).status).toBe(409)
    expect((error as WinnrApiError).operationId).toBe(mutation().operationId)
    expect(h.repository.operations.get(mutation().operationId)?.status).toBe('unknown')
    expect(h.provider.enableWarming).toHaveBeenCalledTimes(1)
  })

  it('treats an unexpected post-submit throw as unknown', async () => {
    const h = harness({
      enableWarming: vi.fn(async () => {
        throw new TypeError('boom')
      }),
    })
    seedConnection(h)
    const error = await mutateWarming(OWNER, h.deps, mutation()).catch((e: unknown) => e)
    expect((error as WinnrApiError).outcomeUnknown).toBe(true)
    expect(h.repository.operations.get(mutation().operationId)?.status).toBe('unknown')
    expect(h.provider.enableWarming).toHaveBeenCalledTimes(1)
  })

  it('never claims success when durable settlement fails', async () => {
    const h = harness()
    seedConnection(h)
    h.repository.settleResult = false
    const error = await mutateWarming(OWNER, h.deps, mutation()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(WinnrApiError)
    expect((error as WinnrApiError).outcomeUnknown).toBe(true)
    expect((error as WinnrApiError).status).toBe(409)
    expect(h.repository.operations.get(mutation().operationId)?.status).toBe('pending')
  })

  it('uses pause/resume without paid confirmation for pause and resume', async () => {
    const h = harness()
    seedConnection(h)
    await mutateWarming(OWNER, h.deps, mutation({ action: 'pause', confirmPaid: undefined }))
    expect(h.provider.pauseWarming).toHaveBeenCalledWith('mb-1')
    await mutateWarming(
      OWNER,
      h.deps,
      mutation({ action: 'resume', operationId: '22222222-2222-4222-8222-222222222222' })
    )
    expect(h.provider.resumeWarming).toHaveBeenCalledWith('mb-1')
    expect(h.provider.enableWarming).not.toHaveBeenCalled()
  })
})
