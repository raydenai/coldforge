/**
 * Body-phase storage deadline regression (Frozen031 P2 closure).
 *
 * The actual body consumer factory must bind the received absolute body
 * deadline into the real service-role connection/token read and the real SMTP
 * mailbox status read. These tests run the actual adapters and worker behind a
 * fake global fetch, so an in-flight Supabase HTTP read is really cancelled, a
 * pre-expired budget makes no storage call, and the body scheduler still gets a
 * held outcome with its failure settlement when the read is cut off.
 *
 * No live Supabase, provider, SMTP, DNS or database call is made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OutreachEventService } from '@/lib/outreach/events'
import {
  createIngestionDeps,
  processWinnrIngestionReceipt,
} from '@/lib/outreach/ingestion-service'
import { createBodyConsumerDeps } from '@/lib/outreach/operations/runtime'
import { createBodyPhasePort } from '@/lib/outreach/operations/scheduler'
import type { WinnrAuthContext } from '@/lib/winnr/server'
import { createWinnrSmtpRepository } from '@/lib/winnr/smtp-database'

const ORG = '11111111-1111-4111-8111-111111111111'
const ACTOR = '22222222-2222-4222-8222-222222222222'
const CONN = '33333333-3333-4333-8333-333333333333'
const RECEIPT = '44444444-4444-4444-8444-444444444444'
const actor: WinnrAuthContext = { userId: ACTOR, organizationId: ORG, role: 'owner' }

const bodyRow = {
  id: ORG,
  organization_id: ORG,
  connection_id: CONN,
  connection_version: 1,
  provider_account_id: 'acct_own',
  account_id: ORG,
  mailbox_id: 'provider-1',
  message_id: '<reply@example.test>',
  in_reply_to: null,
  from_email: 'lead@example.test',
  to_email: 'sender@example.test',
  reply_id: ORG,
  body_status: 'pending',
}

const connectionRow = {
  id: CONN,
  organization_id: ORG,
  provider_account_id: 'acct_own',
  token_ciphertext: 'synthetic-ciphertext',
  account_name: 'Fixture',
  account_plan: null,
  permissions: ['read'],
  universal_inbox_enabled: false,
  version: 1,
  connected_at: '2026-10-05T00:00:00.000Z',
  verified_at: '2026-10-05T00:00:00.000Z',
}

function stubStorageEnv() {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fixture.supabase.co')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-service-key')
}

/** A fetch that records its request signal and rejects only when it aborts. */
function abortableFetch(seen: AbortSignal[]) {
  return vi.fn<typeof globalThis.fetch>((_input, init) => {
    if (init?.signal) seen.push(init.signal)
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
    })
  })
}

function bodyStorageFetch(onConnection: (init?: RequestInit) => Promise<Response>) {
  return vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = String(input)
    if (url.includes('winnr_ingestion_receipts')) return Response.json({ message_record_id: RECEIPT })
    if (url.includes('winnr_ingested_messages')) return Response.json(bodyRow)
    if (url.includes('winnr_connections')) return onConnection(init)
    throw new Error(`unexpected fetch ${url}`)
  })
}

beforeEach(stubStorageEnv)
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('body-phase connection storage deadline', () => {
  it('cancels the real connection/token read and never reaches provider work', async () => {
    const urls: string[] = []
    let connectionSignal: AbortSignal | undefined
    const fetch = bodyStorageFetch((init) => {
      connectionSignal = init?.signal ?? undefined
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      })
    })
    const recording = vi.fn<typeof globalThis.fetch>((input, init) => {
      urls.push(String(input))
      return fetch(input, init)
    })
    vi.stubGlobal('fetch', recording)

    const deadlineAt = Date.now() + 25
    const pending = processWinnrIngestionReceipt(
      actor,
      RECEIPT,
      createIngestionDeps(deadlineAt),
      deadlineAt,
    )
    await expect(pending).rejects.toThrow('Winnr storage query failed')
    expect(connectionSignal).toBeInstanceOf(AbortSignal)
    expect(connectionSignal?.aborted).toBe(true)
    expect(urls.some((url) => url.startsWith('https://api.winnr.app'))).toBe(false)
  })

  it('refuses a pre-expired connection read before any storage call', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error('storage must not be called')
    })
    vi.stubGlobal('fetch', fetch)

    const deps = createIngestionDeps(Date.now() - 1)
    await expect(deps.connections.getConnection(ORG)).rejects.toThrow(
      'Winnr storage deadline exceeded',
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps the legacy no-deadline ingestion connection read unbounded', async () => {
    const signals: (AbortSignal | undefined)[] = []
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      signals.push(init?.signal)
      return Response.json([connectionRow])
    })
    vi.stubGlobal('fetch', fetch)

    const deps = createIngestionDeps()
    await expect(deps.connections.getConnection(ORG)).resolves.toMatchObject({ id: CONN })
    expect(signals).toHaveLength(1)
    expect(signals[0]).toBeUndefined()
  })
})

describe('mailbox status storage deadline', () => {
  it('aborts the real status HTTP read at the supplied absolute deadline', async () => {
    const seen: AbortSignal[] = []
    vi.stubGlobal('fetch', abortableFetch(seen))

    const repository = createWinnrSmtpRepository({ deadlineAt: Date.now() + 25 })
    await expect(repository.status(ORG, CONN, 1)).rejects.toThrow(
      'Private SMTP credential storage failed',
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]?.aborted).toBe(true)
  })

  it('refuses a pre-expired status read before any storage call', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error('storage must not be called')
    })
    vi.stubGlobal('fetch', fetch)

    const repository = createWinnrSmtpRepository({ deadlineAt: Date.now() - 1 })
    await expect(repository.status(ORG, CONN, 1)).rejects.toThrow(
      'Winnr storage deadline exceeded',
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps a live status read bounded and successful', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      expect(init?.signal?.aborted).toBe(false)
      return Response.json([
        {
          provider_mailbox_id: 'provider-1',
          email: 'sender@example.test',
          account_id: ORG,
          synced_at: '2026-10-05T00:00:00.000Z',
        },
      ])
    })
    vi.stubGlobal('fetch', fetch)

    const repository = createWinnrSmtpRepository({ deadlineAt: Date.now() + 5_000 })
    await expect(repository.status(ORG, CONN, 1)).resolves.toEqual([
      {
        providerMailboxId: 'provider-1',
        email: 'sender@example.test',
        accountId: ORG,
        syncedAt: '2026-10-05T00:00:00.000Z',
      },
    ])
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('body scheduler settlement with the actual runtime hydrate', () => {
  it('returns a held outcome and settles when the connection storage read hits the deadline', async () => {
    const fetch = bodyStorageFetch((init) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      })
    })
    vi.stubGlobal('fetch', fetch)

    const fail = vi.fn().mockResolvedValue({ result: 'retryable', attempts: 1 })
    const events = {
      append: vi.fn(),
      claim: vi.fn().mockResolvedValue({
        result: 'claimed',
        jobs: [
          {
            outboxId: '77777777-7777-4777-8777-777777777777',
            eventId: '88888888-8888-4888-8888-888888888888',
            attempts: 1,
            leaseExpiresAt: '2030-01-01T00:00:00.000Z',
            event: {
              version: 1 as const,
              organizationId: ORG,
              type: 'email.received',
              source: 'winnr',
              sourceEventId: 'evt-1',
              occurredAt: '2026-01-01T00:00:00.000Z',
              correlationId: null,
              causationId: null,
              subject: {},
              data: { receiptId: RECEIPT },
            },
          },
        ],
      }),
      ack: vi.fn(),
      fail,
      markUnknown: vi.fn(),
    } as unknown as OutreachEventService

    const port = createBodyPhasePort({ events, hydrate: createBodyConsumerDeps().hydrate })
    const result = await port(actor, Date.now() + 25)

    expect(result.status).toBe('held')
    expect(result.reason).toBe('body_provider_unavailable')
    expect(result.referenceId).toBe(RECEIPT)
    expect(result.referenceFingerprint).toBe('evt-1')
    expect(fail).toHaveBeenCalledTimes(1)
    expect(fail).toHaveBeenCalledWith(
      expect.objectContaining({
        retryable: true,
        errorCode: 'body_provider_unavailable',
        deadlineAt: expect.any(Number),
      }),
    )
  })
})
