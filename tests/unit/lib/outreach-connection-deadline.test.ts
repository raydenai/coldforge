/**
 * Connection/token read deadline regression (Frozen031 follow-up).
 *
 * Proves the service-repository connection/token lookup inside
 * `requireConnection` obeys the caller's absolute phase deadline: an in-flight
 * read is actually aborted, a pre-expired budget makes no DB call, and the
 * healthy/default path is unchanged. Only fake fetch + fake clients are used;
 * no live Supabase, Winnr, SMTP or DNS call is made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { encrypt } from '@/lib/encryption'
import { createServiceRoleRepository, type WinnrDatabase } from '@/lib/winnr/database'
import { createEmailDispatchDeps } from '@/lib/outreach/dispatch-runtime'
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
  vi.stubEnv('ENCRYPTION_SECRET', 'fixture-encryption-secret')
  vi.stubEnv('ENCRYPTION_SALT', 'fixture-encryption-salt')
}

function connectionRow() {
  return {
    id: CONN,
    organization_id: ORG,
    provider_account_id: 'acct-1',
    token_ciphertext: encrypt('synthetic-token'),
    account_name: 'Sender',
    account_plan: null,
    permissions: ['read'],
    universal_inbox_enabled: false,
    version: 1,
    connected_at: '2026-01-01T00:00:00.000Z',
    verified_at: '2026-01-01T00:00:00.000Z',
  }
}

function storageClient(fetch: typeof globalThis.fetch) {
  return createClient<WinnrDatabase>('https://fixture.supabase.co', 'fixture-service-key', {
    global: { fetch },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/** A fetch that never resolves on its own and rejects when its signal aborts. */
function abortableFetch(seen: AbortSignal[]) {
  return vi.fn<typeof globalThis.fetch>(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        if (init?.signal) seen.push(init.signal)
        const signal = init?.signal
        const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      })
  )
}

beforeEach(stubStorageEnv)
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('service-repository connection/token deadline', () => {
  it('refuses a pre-expired read before any storage call', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error('storage must not be called')
    })
    const repository = createServiceRoleRepository({ client: storageClient(fetch), deadlineAt: Date.now() - 1 })
    await expect(repository.getConnectionWithToken(ORG)).rejects.toThrow('Winnr storage deadline exceeded')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('aborts an in-flight read at the absolute deadline', async () => {
    const seen: AbortSignal[] = []
    const repository = createServiceRoleRepository({
      client: storageClient(abortableFetch(seen)),
      deadlineAt: Date.now() + 80,
    })
    await expect(repository.getConnectionWithToken(ORG)).rejects.toThrow('Winnr storage query failed')
    expect(seen).toHaveLength(1)
    expect(seen[0]?.aborted).toBe(true)
  })

  it('keeps the abort active while the response body is consumed', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => {
      // Headers resolve immediately; the body never produces bytes until the
      // deadline signal fires, proving the abort reaches body consumption too.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const signal = init?.signal
          const abort = () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          if (signal?.aborted) abort()
          else signal?.addEventListener('abort', abort, { once: true })
        },
      })
      return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }))
    })
    const repository = createServiceRoleRepository({
      client: storageClient(fetch),
      deadlineAt: Date.now() + 80,
    })
    await expect(repository.getConnectionWithToken(ORG)).rejects.toThrow('Winnr storage query failed')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('combines a caller signal with the read instead of replacing it', async () => {
    const controller = new AbortController()
    const seen: AbortSignal[] = []
    const repository = createServiceRoleRepository({
      client: storageClient(abortableFetch(seen)),
      signal: controller.signal,
    })
    const pending = repository.getConnectionWithToken(ORG).catch((error: unknown) => error)
    controller.abort()
    await expect(pending).resolves.toBeInstanceOf(Error)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.aborted).toBe(true)
  })

  it('keeps the default no-deadline read unchanged', async () => {
    const row = connectionRow()
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json([row]))
    const repository = createServiceRoleRepository({ client: storageClient(fetch) })
    const connection = await repository.getConnection(ORG)
    expect(connection?.id).toBe(CONN)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect((fetch.mock.calls[0]?.[1] as RequestInit | undefined)?.signal).toBeUndefined()
  })
})

describe('dispatch connection/token deadline end-to-end', () => {
  it('aborts the read then never fetches a provider mailbox or grant', async () => {
    const unexpected: string[] = []
    const storageSignals: AbortSignal[] = []
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
      const url = String(input)
      if (url.includes('/rest/v1/winnr_connections')) {
        if (init?.signal) storageSignals.push(init.signal)
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          if (signal?.aborted) abort()
          else signal?.addEventListener('abort', abort, { once: true })
        })
      }
      // A provider mailbox fetch, a claim/grant RPC or an SMTP preflight read
      // would all land here; the regression requires none of them.
      unexpected.push(url)
      return Promise.reject(new Error(`unexpected fetch ${url}`))
    })
    vi.stubGlobal('fetch', fetch)
    const deps = createEmailDispatchDeps(actor, Date.now() + 80)
    await expect(deps.mailboxAvailable(mailboxInput)).rejects.toThrow()
    expect(unexpected).toEqual([])
    expect(storageSignals).toHaveLength(1)
    expect(storageSignals[0]?.aborted).toBe(true)
  })

  it('completes the bounded read and provider fetch inside a live budget', async () => {
    const row = connectionRow()
    const calls: string[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/rest/v1/winnr_connections')) {
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        expect(init?.signal?.aborted).toBe(false)
        return Response.json([row])
      }
      if (url.startsWith('https://api.winnr.app')) {
        return Response.json({
          data: [
            {
              id: 'mb-1',
              full_address: 'sender@example.test',
              name: 'Sender',
              status: 'active',
              daily_send_limit: 10,
            },
          ],
          pagination: { has_more: false },
        })
      }
      throw new Error(`unexpected fetch ${url}`)
    })
    vi.stubGlobal('fetch', fetch)
    const deps = createEmailDispatchDeps(actor, Date.now() + 20_000)
    await expect(deps.mailboxAvailable(mailboxInput)).resolves.toBe(true)
    expect(calls.some((url) => url.startsWith('https://api.winnr.app'))).toBe(true)
  })
})
