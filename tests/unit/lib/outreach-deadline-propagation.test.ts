/**
 * Absolute-deadline propagation contract for the remaining in-flight ports.
 *
 * These tests use fake fetch/provider boundaries only. No live provider, SMTP,
 * DNS or Supabase call is made: the SDK/client boundary is exercised directly
 * so cancellation and budget refusal are proven without a real network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  buildWinnrDeps: vi.fn(),
  listMailboxes: vi.fn(),
}))

vi.mock('@/app/api/winnr/_shared', () => ({ buildWinnrDeps: mocks.buildWinnrDeps }))
vi.mock('@/lib/winnr/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/winnr/server')>()
  return { ...actual, listMailboxes: mocks.listMailboxes }
})

import { WinnrClient, WinnrError } from '@/lib/winnr/client'
import { createEmailDispatchDeps } from '@/lib/outreach/dispatch-runtime'
import { createReplyRepository } from '@/lib/outreach/replies-database'
import { createReplyDeps } from '@/lib/outreach/replies-runtime'
import type { WinnrAuthContext } from '@/lib/winnr/server'

const ORG = '11111111-1111-4111-8111-111111111111'
const ACTOR = '22222222-2222-4222-8222-222222222222'
const CONN = '33333333-3333-4333-8333-333333333333'
const actor: WinnrAuthContext = { userId: ACTOR, organizationId: ORG, role: 'owner' }
const mailboxInput = {
  organizationId: ORG,
  connectionId: CONN,
  connectionVersion: 1,
  mailboxId: 'mb-1',
  email: 'sender@example.test',
  dailyLimit: 5,
}

function stubStorageEnv() {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fixture.supabase.co')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fixture-service-key')
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://fixture.example')
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  mocks.buildWinnrDeps.mockReset()
  mocks.listMailboxes.mockReset()
})

describe('WinnrClient caller cancellation', () => {
  it('combines the caller signal with the request timeout instead of replacing it', async () => {
    const controller = new AbortController()
    const seen: AbortSignal[] = []
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) seen.push(init.signal)
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      })
    })
    const client = WinnrClient({
      token: 'synthetic-token',
      fetch: fetchImpl as unknown as typeof fetch,
      timeoutMs: 60_000,
      signal: controller.signal,
    })
    const pending = client.listMailboxes({ limit: 1 }).catch((error: unknown) => error)
    controller.abort()
    const error = await pending
    expect(error).toBeInstanceOf(WinnrError)
    expect(seen[0]).toBeInstanceOf(AbortSignal)
    expect(seen[0]?.aborted).toBe(true)
  })
})

describe('reply storage deadline', () => {
  beforeEach(stubStorageEnv)

  it('rejects an already-expired budget before any storage call', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const repository = createReplyRepository(false, Date.now() - 1)
    await expect(repository.call('actor', 'org', 'readiness', {})).rejects.toThrow(
      'Reply storage deadline exceeded'
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('sends a bounded live signal and completes normally within the budget', async () => {
    const fetchSpy = vi.fn(async () => Response.json({ ready: true }))
    vi.stubGlobal('fetch', fetchSpy)
    const repository = createReplyRepository(false, Date.now() + 5_000)
    await expect(repository.call('actor', 'org', 'readiness', {})).resolves.toEqual({ ready: true })
    const signal = (fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined)?.signal
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal?.aborted).toBe(false)
  })
})

describe('reply dependency deadline port', () => {
  beforeEach(stubStorageEnv)

  it('accepts the third absolute deadline and refuses an expired budget before any provider read', async () => {
    const deps = createReplyDeps(actor, Date.now(), Date.now() - 1)
    expect(typeof deps.repository.call).toBe('function')
    expect(await deps.mailboxAvailable(mailboxInput)).toBe(false)
    expect(mocks.buildWinnrDeps).not.toHaveBeenCalled()
    expect(mocks.listMailboxes).not.toHaveBeenCalled()
  })

  it('binds the mailbox preflight with a provider signal when the budget is live', async () => {
    mocks.buildWinnrDeps.mockReturnValue({ repository: {}, createProvider: () => ({}) })
    mocks.listMailboxes.mockResolvedValue({
      connectionId: CONN,
      connectionVersion: 1,
      items: [],
      hasMore: false,
      nextCursor: null,
      observedAt: '2026-10-05T00:00:00.000Z',
    })
    const deps = createReplyDeps(actor, Date.now(), Date.now() + 20_000)
    expect(await deps.mailboxAvailable(mailboxInput)).toBe(false)
    const options = mocks.buildWinnrDeps.mock.calls[0]?.[0] as { signal?: AbortSignal } | undefined
    expect(options?.signal).toBeInstanceOf(AbortSignal)
    expect(options?.signal?.aborted).toBe(false)
    expect(mocks.listMailboxes).toHaveBeenCalledTimes(1)
  })

  it('keeps the legacy 0/1/2-argument calls working without an absolute deadline', () => {
    for (const deps of [createReplyDeps(actor), createReplyDeps(actor, Date.now())]) {
      expect(deps).toMatchObject({
        appUrl: expect.any(String),
        repository: expect.any(Object),
        transport: expect.any(Object),
      })
      expect(typeof deps.mailboxAvailable).toBe('function')
    }
  })
})

describe('dispatch mailbox preflight cancellation', () => {
  beforeEach(stubStorageEnv)

  it('derives a provider signal from the request deadline and reads once', async () => {
    mocks.buildWinnrDeps.mockReturnValue({ repository: {}, createProvider: () => ({}) })
    mocks.listMailboxes.mockResolvedValue({
      connectionId: CONN,
      connectionVersion: 1,
      items: [],
      hasMore: false,
      nextCursor: null,
      observedAt: '2026-10-05T00:00:00.000Z',
    })
    const deps = createEmailDispatchDeps(actor, Date.now() + 5_000)
    expect(await deps.mailboxAvailable(mailboxInput)).toBe(false)
    const options = mocks.buildWinnrDeps.mock.calls[0]?.[0] as
      | { signal?: AbortSignal; deadlineAt?: number }
      | undefined
    expect(options?.signal).toBeInstanceOf(AbortSignal)
    expect(options?.signal?.aborted).toBe(false)
    expect(options?.deadlineAt).toBeGreaterThan(Date.now())
    expect(mocks.listMailboxes).toHaveBeenCalledTimes(1)
  })

  it('fails closed before constructing a provider when the budget is already gone', async () => {
    const deps = createEmailDispatchDeps(actor, Date.now() - 1)
    expect(await deps.mailboxAvailable(mailboxInput)).toBe(false)
    expect(mocks.buildWinnrDeps).not.toHaveBeenCalled()
    expect(mocks.listMailboxes).not.toHaveBeenCalled()
  })
})
