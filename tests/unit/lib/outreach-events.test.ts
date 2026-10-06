/**
 * Unit contract for the pure outreach event service and the narrow Supabase
 * adapter (migration 021). No database is required: the service is exercised
 * through an injected fake repository and the adapter through a fake HTTP
 * fetch, so validation, fingerprinting and RPC wiring are proven in isolation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import {
  computeEventFingerprint,
  createOutreachEventService,
  normalizeOutreachEvent,
  OutreachEventValidationError,
  type AppendEventRepositoryInput,
  type FailOutboxRepositoryInput,
  type MarkUnknownRepositoryInput,
  type OutreachEventRepository,
  type ClaimOutboxRepositoryInput,
  type SettleOutboxRepositoryInput,
} from '@/lib/outreach/events'
import {
  createOutreachEventRepository,
  getOutreachServiceRoleConfig,
  type OutreachDatabase,
} from '@/lib/outreach/event-database'

afterEach(() => vi.unstubAllEnvs())

const ORG = '11111111-1111-4111-8111-111111111111'
const ORG_B = '11111111-1111-4111-8111-111111111222'
const LEAD = '22222222-2222-4222-8222-222222222222'
const OUTBOX = '44444444-4444-4444-8444-444444444444'
const LEASE = '55555555-5555-4555-8555-555555555555'
const EXPIRES = '2026-10-05T12:05:00.123456+00:00'

function canonicalEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    organizationId: ORG,
    type: 'lead.replied',
    source: 'winnr',
    sourceEventId: 'evt-0001',
    occurredAt: '2026-10-05T12:00:00.000Z',
    correlationId: null,
    causationId: null,
    subject: { leadId: LEAD, campaignId: null },
    data: { classification: 'interested', nested: { score: 3 } },
    ...overrides,
  }
}

class FakeRepository implements OutreachEventRepository {
  readonly appendInputs: AppendEventRepositoryInput[] = []
  readonly claimInputs: ClaimOutboxRepositoryInput[] = []
  readonly ackInputs: SettleOutboxRepositoryInput[] = []
  readonly failInputs: FailOutboxRepositoryInput[] = []
  readonly unknownInputs: MarkUnknownRepositoryInput[] = []

  constructor(
    private readonly outcomes: {
      append?: Awaited<ReturnType<OutreachEventRepository['appendEvent']>>
      claim?: Awaited<ReturnType<OutreachEventRepository['claimOutbox']>>
    } = {}
  ) {}

  async appendEvent(input: AppendEventRepositoryInput) {
    this.appendInputs.push(input)
    return this.outcomes.append ?? { result: 'created', eventId: OUTBOX }
  }

  async claimOutbox(input: ClaimOutboxRepositoryInput) {
    this.claimInputs.push(input)
    return this.outcomes.claim ?? { result: 'claimed' as const, jobs: [] }
  }

  async ackOutbox(input: SettleOutboxRepositoryInput) {
    this.ackInputs.push(input)
    return { result: 'acked' as const }
  }

  async failOutbox(input: FailOutboxRepositoryInput) {
    this.failInputs.push(input)
    return { result: 'retryable' as const, attempts: 1 }
  }

  async markUnknown(input: MarkUnknownRepositoryInput) {
    this.unknownInputs.push(input)
    return { result: 'unknown' as const }
  }
}

describe('canonical v1 event validation', () => {
  it('normalizes optional fields, pins version 1 and drops null subject ids', () => {
    const normalized = normalizeOutreachEvent(canonicalEvent())
    expect(normalized.version).toBe(1)
    expect(normalized.occurredAt).toBe('2026-10-05T12:00:00.000Z')
    expect(normalized.correlationId).toBeNull()
    expect(normalized.subject).toEqual({ leadId: LEAD })
    expect(normalized.data).toEqual({ classification: 'interested', nested: { score: 3 } })
  })

  it('requires the explicit version 1', () => {
    const withoutVersion = canonicalEvent()
    delete withoutVersion.version
    expect(() => normalizeOutreachEvent(withoutVersion)).toThrow(OutreachEventValidationError)
    expect(() => normalizeOutreachEvent(canonicalEvent({ version: 2 }))).toThrow(
      OutreachEventValidationError
    )
    expect(() => normalizeOutreachEvent(canonicalEvent({ version: '1' }))).toThrow(
      OutreachEventValidationError
    )
  })

  it.each([
    ['non-uuid organization', canonicalEvent({ organizationId: 'not-a-uuid' })],
    ['blank type', canonicalEvent({ type: '   ' })],
    ['newline in source', canonicalEvent({ source: 'win\nnr' })],
    ['non-ascii type', canonicalEvent({ type: 'replied\u00e9' })],
    ['blank source event id', canonicalEvent({ sourceEventId: '  ' })],
    ['bad timestamp', canonicalEvent({ occurredAt: 'yesterday' })],
    ['timestamp without timezone', canonicalEvent({ occurredAt: '2026-10-05T12:00:00' })],
    ['timestamp shorthand', canonicalEvent({ occurredAt: '1' })],
    ['impossible calendar date', canonicalEvent({ occurredAt: '2026-02-30T12:00:00Z' })],
    ['unknown subject key', canonicalEvent({ subject: { dealId: LEAD } })],
    ['non-uuid subject id', canonicalEvent({ subject: { leadId: 'nope' } })],
    ['typed subject id', canonicalEvent({ subject: { leadId: 123 } })],
    ['data as array', canonicalEvent({ data: [1, 2, 3] })],
    ['data leaf undefined', canonicalEvent({ data: { disposition: undefined } })],
    ['data leaf function', canonicalEvent({ data: { disposition: () => 'opt-out' } })],
    ['data leaf NaN', canonicalEvent({ data: { score: Number.NaN } })],
    ['data leaf Infinity', canonicalEvent({ data: { score: Number.POSITIVE_INFINITY } })],
    ['data leaf Date', canonicalEvent({ data: { instant: new Date('2026-10-05T12:00:00Z') } })],
    ['data leaf bigint', canonicalEvent({ data: { id: BigInt(1) } })],
    ['data leaf Map', canonicalEvent({ data: { lookup: new Map() } })],
    ['unknown top-level key', { ...canonicalEvent(), extra: true }],
  ])('rejects %s', (_label, input) => {
    expect(() => normalizeOutreachEvent(input)).toThrow(OutreachEventValidationError)
  })

  it('accepts explicit UTC and offset instants and canonicalizes to UTC', () => {
    expect(
      normalizeOutreachEvent(canonicalEvent({ occurredAt: '2026-10-05T12:00:00Z' })).occurredAt
    ).toBe('2026-10-05T12:00:00.000Z')
    expect(
      normalizeOutreachEvent(canonicalEvent({ occurredAt: '2026-10-05T05:00:00-07:00' })).occurredAt
    ).toBe('2026-10-05T12:00:00.000Z')
  })

  it('bounds the normalized UTC occurredAt year to 1..9999', () => {
    expect(
      normalizeOutreachEvent(canonicalEvent({ occurredAt: '0001-01-01T00:00:00Z' })).occurredAt
    ).toBe('0001-01-01T00:00:00.000Z')
    expect(
      normalizeOutreachEvent(canonicalEvent({ occurredAt: '9999-12-31T23:59:59Z' })).occurredAt
    ).toBe('9999-12-31T23:59:59.000Z')
    for (const occurredAt of [
      '0000-06-15T12:00:00Z',
      '0001-01-01T00:00:00+01:00',
      '9999-12-31T23:59:59-01:00',
    ]) {
      expect(() => normalizeOutreachEvent(canonicalEvent({ occurredAt }))).toThrow(
        OutreachEventValidationError
      )
    }
  })

  it('rejects all-hole and mixed sparse arrays instead of persisting nulls', () => {
    const allHoles = new Array(2)
    const mixed = new Array(3)
    mixed[0] = 'a'
    mixed[2] = 'c'
    const nested = { outer: { list: new Array(1) } }
    for (const data of [{ list: allHoles }, { list: mixed }, nested]) {
      expect(() => normalizeOutreachEvent(canonicalEvent({ data }))).toThrow(
        OutreachEventValidationError
      )
    }
  })

  it('returns a plain canonical JSON tree with no lossy leaves', () => {
    const normalized = normalizeOutreachEvent(
      canonicalEvent({ data: { list: [1, true, null, { deep: 'ok' }] } })
    )
    expect(normalized.data).toEqual({ list: [1, true, null, { deep: 'ok' }] })
    expect(Object.getPrototypeOf(normalized.data)).toBe(Object.prototype)
    expect(Object.getPrototypeOf(normalized.data.list)).toBe(Array.prototype)
  })

  it('preserves an own __proto__ key without prototype pollution', () => {
    const data = JSON.parse('{"__proto__":{"polluted":true},"ok":1}') as Record<string, unknown>
    const normalized = normalizeOutreachEvent(canonicalEvent({ data }))
    expect(Object.prototype.hasOwnProperty.call(normalized.data, '__proto__')).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('rejects an oversized payload', () => {
    const big = canonicalEvent({ data: { blob: 'x'.repeat(20000) } })
    expect(() => normalizeOutreachEvent(big)).toThrow(/maximum size/)
  })

  it('rejects data that is too deeply nested', () => {
    let nested: Record<string, unknown> = { end: true }
    for (let i = 0; i < 10; i += 1) nested = { next: nested }
    expect(() => normalizeOutreachEvent(canonicalEvent({ data: nested }))).toThrow(/maximum depth/)
  })
})

describe('deterministic fingerprint', () => {
  it('is stable across object key order and absent-before-present nulls', () => {
    const a = computeEventFingerprint(canonicalEvent({ data: { a: 1, b: { d: 4, c: 3 } } }))
    const b = computeEventFingerprint(canonicalEvent({ data: { b: { c: 3, d: 4 }, a: 1 } }))
    expect(a).toHaveLength(64)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).toBe(b)
  })

  it('changes when canonical content changes', () => {
    const a = computeEventFingerprint(canonicalEvent())
    const b = computeEventFingerprint(canonicalEvent({ data: { classification: 'hostile' } }))
    expect(a).not.toBe(b)
  })
})

describe('service append contract', () => {
  it('forwards the normalized event, unique consumers and a fingerprint', async () => {
    const repository = new FakeRepository()
    const service = createOutreachEventService({ repository })
    const result = await service.append({
      event: canonicalEvent(),
      consumers: ['crm.sync', 'inbox.route'],
    })
    expect(result).toEqual({ result: 'created', eventId: OUTBOX })
    expect(repository.appendInputs).toHaveLength(1)
    const sent = repository.appendInputs[0]
    expect(sent.organizationId).toBe(ORG)
    expect(sent.consumers).toEqual(['crm.sync', 'inbox.route'])
    expect(sent.fingerprint).toBe(computeEventFingerprint(canonicalEvent()))
    expect(sent.event.subject).toEqual({ leadId: LEAD })
  })

  it('rejects duplicate consumer names before touching storage', async () => {
    const repository = new FakeRepository()
    const service = createOutreachEventService({ repository })
    await expect(
      service.append({ event: canonicalEvent(), consumers: ['crm.sync', 'crm.sync'] })
    ).rejects.toThrow(/unique/)
    expect(repository.appendInputs).toHaveLength(0)
  })

  it('allows an audit-only event with zero consumers', async () => {
    const repository = new FakeRepository()
    const service = createOutreachEventService({ repository })
    const result = await service.append({ event: canonicalEvent(), consumers: [] })
    expect(result).toEqual({ result: 'created', eventId: OUTBOX })
    expect(repository.appendInputs[0].consumers).toEqual([])
  })

  it('rejects null entries and non-array consumer sets', async () => {
    const repository = new FakeRepository()
    const service = createOutreachEventService({ repository })
    await expect(
      service.append({ event: canonicalEvent(), consumers: [null] })
    ).rejects.toThrow(OutreachEventValidationError)
    await expect(
      service.append({ event: canonicalEvent(), consumers: null })
    ).rejects.toThrow(OutreachEventValidationError)
    expect(repository.appendInputs).toHaveLength(0)
  })

  it('passes duplicate and conflict outcomes through unchanged', async () => {
    const duplicate = new FakeRepository({ append: { result: 'duplicate', eventId: OUTBOX } })
    const conflict = new FakeRepository({ append: { result: 'conflict', eventId: OUTBOX } })
    await expect(
      createOutreachEventService({ repository: duplicate }).append({
        event: canonicalEvent(),
        consumers: ['crm.sync'],
      })
    ).resolves.toEqual({ result: 'duplicate', eventId: OUTBOX })
    await expect(
      createOutreachEventService({ repository: conflict }).append({
        event: canonicalEvent(),
        consumers: ['crm.sync'],
      })
    ).resolves.toEqual({ result: 'conflict', eventId: OUTBOX })
  })
})

describe('service claim and settlement validation', () => {
  it('validates and forwards a lease claim', async () => {
    const repository = new FakeRepository()
    const service = createOutreachEventService({ repository })
    await service.claim({
      organizationId: ORG,
      consumer: 'crm.sync',
      leaseToken: LEASE,
      leaseSeconds: 60,
      limit: 10,
    })
    expect(repository.claimInputs).toEqual([
      { organizationId: ORG, consumer: 'crm.sync', leaseToken: LEASE, leaseSeconds: 60, limit: 10 },
    ])
  })

  it('rejects an out-of-range lease duration', async () => {
    const service = createOutreachEventService({ repository: new FakeRepository() })
    await expect(
      service.claim({
        organizationId: ORG,
        consumer: 'crm.sync',
        leaseToken: LEASE,
        leaseSeconds: 0,
        limit: 10,
      })
    ).rejects.toThrow(OutreachEventValidationError)
  })

  it('forwards a live ack, a bounded retryable failure and an unknown hold', async () => {
    const repository = new FakeRepository()
    const service = createOutreachEventService({ repository })
    const settle = { organizationId: ORG, outboxId: OUTBOX, leaseToken: LEASE, leaseExpiresAt: EXPIRES }
    await expect(service.ack(settle)).resolves.toEqual({ result: 'acked' })
    await expect(
      service.fail({ ...settle, errorCode: 'transport_reset', retryable: true })
    ).resolves.toEqual({ result: 'retryable', attempts: 1 })
    await expect(service.markUnknown({ ...settle, reason: 'provider_timeout' })).resolves.toEqual({
      result: 'unknown',
    })
    expect(repository.ackInputs[0]).toEqual(settle)
    expect(repository.failInputs[0]).toMatchObject({ errorCode: 'transport_reset', retryable: true })
    expect(repository.unknownInputs[0]).toMatchObject({ reason: 'provider_timeout' })
  })

  it('rejects a cross-organization settlement with a non-uuid organization', async () => {
    const service = createOutreachEventService({ repository: new FakeRepository() })
    await expect(
      service.ack({ organizationId: 'other-org', outboxId: OUTBOX, leaseToken: LEASE, leaseExpiresAt: EXPIRES })
    ).rejects.toThrow(OutreachEventValidationError)
  })

  it('forwards an optional per-call deadline into every settlement RPC input', async () => {
    const repository = new FakeRepository()
    const service = createOutreachEventService({ repository })
    const deadlineAt = 1_760_000_000_000
    const claim = { organizationId: ORG, consumer: 'crm.sync', leaseToken: LEASE, leaseSeconds: 60, limit: 1, deadlineAt }
    const settle = { organizationId: ORG, outboxId: OUTBOX, leaseToken: LEASE, leaseExpiresAt: EXPIRES, deadlineAt }
    await service.claim(claim)
    await service.ack(settle)
    await service.fail({ ...settle, errorCode: 'transport_reset', retryable: true })
    await service.markUnknown({ ...settle, reason: 'provider_timeout' })
    expect(repository.claimInputs[0]).toEqual(claim)
    expect(repository.ackInputs[0]).toEqual(settle)
    expect(repository.failInputs[0]).toMatchObject({ errorCode: 'transport_reset', retryable: true, deadlineAt })
    expect(repository.unknownInputs[0]).toMatchObject({ reason: 'provider_timeout', deadlineAt })
    // The deadline is transport metadata only: lease/fencing fields are intact.
    expect(repository.ackInputs[0]).toMatchObject({ outboxId: OUTBOX, leaseToken: LEASE, leaseExpiresAt: EXPIRES })
  })

  it('omits deadline metadata entirely on legacy calls', async () => {
    const repository = new FakeRepository()
    const service = createOutreachEventService({ repository })
    const settle = { organizationId: ORG, outboxId: OUTBOX, leaseToken: LEASE, leaseExpiresAt: EXPIRES }
    await service.claim({ organizationId: ORG, consumer: 'crm.sync', leaseToken: LEASE, leaseSeconds: 60, limit: 1 })
    await service.ack(settle)
    await service.fail({ ...settle, errorCode: null, retryable: false })
    await service.markUnknown({ ...settle, reason: null })
    for (const input of [
      repository.claimInputs[0],
      repository.ackInputs[0],
      repository.failInputs[0],
      repository.unknownInputs[0],
    ]) {
      expect(input).not.toHaveProperty('deadlineAt')
    }
  })

  it('rejects a non-finite per-call deadline before touching storage', async () => {
    const repository = new FakeRepository()
    const service = createOutreachEventService({ repository })
    await expect(
      service.ack({ organizationId: ORG, outboxId: OUTBOX, leaseToken: LEASE, leaseExpiresAt: EXPIRES, deadlineAt: -1 })
    ).rejects.toThrow(OutreachEventValidationError)
    expect(repository.ackInputs).toHaveLength(0)
  })


  it('preserves lease-expiry microsecond precision without Date normalization', async () => {
    const repository = new FakeRepository()
    const service = createOutreachEventService({ repository })
    const precise = '2026-10-05T12:00:00.123456+00:00'
    await service.ack({
      organizationId: ORG,
      outboxId: OUTBOX,
      leaseToken: LEASE,
      leaseExpiresAt: precise,
    })
    expect(repository.ackInputs[0].leaseExpiresAt).toBe(precise)
  })

  it.each([
    ['shorthand', '1'],
    ['local time without offset', '2026-10-05T12:00:00'],
    ['impossible calendar date', '2026-02-30T00:00:00Z'],
    ['out-of-range offset', '2026-10-05T12:00:00+25:00'],
  ])('rejects a %s lease expiry', async (_label, leaseExpiresAt) => {
    const repository = new FakeRepository()
    const service = createOutreachEventService({ repository })
    await expect(
      service.ack({ organizationId: ORG, outboxId: OUTBOX, leaseToken: LEASE, leaseExpiresAt })
    ).rejects.toThrow(OutreachEventValidationError)
    expect(repository.ackInputs).toHaveLength(0)
  })
})

describe('Supabase adapter', () => {
  function clientWith(fetchImpl: ReturnType<typeof vi.fn>) {
    return createClient<OutreachDatabase>('https://fixture.supabase.co', 'fixture-service-key', {
      global: { fetch: fetchImpl },
      auth: { persistSession: false, autoRefreshToken: false },
    })
  }

  it('calls the typed append RPC with the canonical event', async () => {
    const fetch = vi.fn(async () => Response.json({ result: 'created', event_id: OUTBOX }))
    const repository = createOutreachEventRepository({ client: clientWith(fetch) })
    const result = await repository.appendEvent({
      organizationId: ORG,
      event: normalizeOutreachEvent(canonicalEvent()),
      consumers: ['crm.sync'],
      fingerprint: computeEventFingerprint(canonicalEvent()),
    })
    expect(result).toEqual({ result: 'created', eventId: OUTBOX })
    expect(String(fetch.mock.calls[0]?.[0])).toContain('/rest/v1/rpc/outreach_append_event')
  })

  it('parses claimed jobs including their canonical event', async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        result: 'claimed',
        jobs: [
          {
            outboxId: OUTBOX,
            eventId: ORG_B,
            attempts: 2,
            leaseExpiresAt: EXPIRES,
            event: canonicalEvent(),
          },
        ],
      })
    )
    const repository = createOutreachEventRepository({ client: clientWith(fetch) })
    const result = await repository.claimOutbox({
      organizationId: ORG,
      consumer: 'crm.sync',
      leaseToken: LEASE,
      leaseSeconds: 60,
      limit: 1,
    })
    expect(result.jobs).toHaveLength(1)
    expect(result.jobs[0]).toMatchObject({ outboxId: OUTBOX, attempts: 2, leaseExpiresAt: EXPIRES })
    expect(result.jobs[0].event.version).toBe(1)
    expect(result.jobs[0].event.sourceEventId).toBe('evt-0001')
    expect(String(fetch.mock.calls[0]?.[0])).toContain('/rest/v1/rpc/outreach_claim_outbox')
  })

  it('surfaces a stale ack result rather than treating it as success', async () => {
    const fetch = vi.fn(async () => Response.json({ result: 'stale' }))
    const repository = createOutreachEventRepository({ client: clientWith(fetch) })
    await expect(
      repository.ackOutbox({ organizationId: ORG, outboxId: OUTBOX, leaseToken: LEASE, leaseExpiresAt: EXPIRES })
    ).resolves.toEqual({ result: 'stale' })
  })

  it('passes a bounded abort signal for a future per-call deadline', async () => {
    const fetch = vi.fn(async () => Response.json({ result: 'acked' }))
    const repository = createOutreachEventRepository({ client: clientWith(fetch) })
    await repository.ackOutbox({
      organizationId: ORG,
      outboxId: OUTBOX,
      leaseToken: LEASE,
      leaseExpiresAt: EXPIRES,
      deadlineAt: Date.now() + 5_000,
    })
    const signal = fetch.mock.calls[0]?.[1]?.signal
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal?.aborted).toBe(false)
  })

  it('aborts an already-expired settlement so a late result can never land', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          if (signal?.aborted) abort()
          else signal?.addEventListener('abort', abort, { once: true })
        })
    )
    const repository = createOutreachEventRepository({ client: clientWith(fetch) })
    await expect(
      repository.markUnknown({
        organizationId: ORG,
        outboxId: OUTBOX,
        leaseToken: LEASE,
        leaseExpiresAt: EXPIRES,
        reason: 'expired',
        deadlineAt: Date.now() - 1,
      })
    ).rejects.toThrow('Outreach storage unknown report failed')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })

  it('fails without a service-role key even when an anon key exists', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fixture.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'fixture-anon-key')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
    expect(getOutreachServiceRoleConfig).toThrow('Outreach event storage is not configured')
  })
})
