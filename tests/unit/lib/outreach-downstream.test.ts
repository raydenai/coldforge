/**
 * Focused unit tests for the bounded downstream module. No network, no
 * database and no provider account: fetch is always faked and credentials are
 * synthetic.
 */
import { describe, expect, it, vi } from 'vitest'
import { createHash, createHmac, generateKeyPairSync, sign } from 'node:crypto'
import {
  DECISION_CONSUMER,
  DownstreamError,
  type GhlPort,
  type RetellPort,
} from '@/lib/outreach/downstream/core'
import {
  createCloseBotPort,
  createGhlPort,
  createRetellPort,
  readBoundedRequestBody,
  verifyGhlSignature,
  verifyRetellSignature,
  verifySharedToken,
} from '@/lib/outreach/downstream/providers'
import { effectFingerprint, readDecisionId, readSourceReplyId, reserveDecisionEffects, initiateRequestedCallback, executeReservedEffect } from '@/lib/outreach/downstream/scheduler'
import { requestAppointment, saveConnection, cancelAppointment, listCalendars, checkConnection } from '@/lib/outreach/downstream/service'
import { decrypt, encrypt } from '@/lib/encryption'
import type { DownstreamRepository } from '@/lib/outreach/downstream/database'
import type { DownstreamWorkerDeps } from '@/lib/outreach/downstream/runtime'
import type { OutreachEventV1 } from '@/lib/outreach/events'

// ---------------------------------------------------------------------------
// Fake HTTP
// ---------------------------------------------------------------------------
type Captured = { url: string; init: RequestInit }

function fakeResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  const bytes = new TextEncoder().encode(body)
  let sent = false
  return {
    status,
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
    body: {
      getReader: () => ({
        read: async () => (sent ? { done: true, value: undefined } : ((sent = true), { done: false, value: bytes })),
        cancel: async () => undefined,
        releaseLock: () => undefined,
      }),
    },
  } as unknown as Response
}

function capture(body: string, status = 200): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = []
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return fakeResponse(body, status)
  }) as typeof fetch
  return { fetch: fn, calls }
}

// ---------------------------------------------------------------------------
// Signatures
// ---------------------------------------------------------------------------
describe('provider signature verification', () => {
  it('accepts a correctly signed and fresh Retell webhook', () => {
    const apiKey = 'retell_test_key'
    const body = '{"event":"call_started","call":{"call_id":"call_1"}}'
    const timestamp = String(Date.now())
    const digest = createHmac('sha256', apiKey).update(body + timestamp).digest('hex')
    expect(verifyRetellSignature(body, `v=${timestamp},d=${digest}`, apiKey)).toBe(true)
  })

  it('rejects a tampered body, wrong key and stale timestamp', () => {
    const apiKey = 'retell_test_key'
    const body = '{"event":"call_started"}'
    const timestamp = String(Date.now())
    const digest = createHmac('sha256', apiKey).update(body + timestamp).digest('hex')
    expect(verifyRetellSignature(body + 'x', `v=${timestamp},d=${digest}`, apiKey)).toBe(false)
    expect(verifyRetellSignature(body, `v=${timestamp},d=${digest}`, 'other_key')).toBe(false)
    const stale = String(Date.now() - 10 * 60 * 1000)
    const staleDigest = createHmac('sha256', apiKey).update(body + stale).digest('hex')
    expect(verifyRetellSignature(body, `v=${stale},d=${staleDigest}`, apiKey)).toBe(false)
    expect(verifyRetellSignature(body, null, apiKey)).toBe(false)
  })

  it('verifies an Ed25519 GHL signature (base64 of the raw UTF-8 body) and rejects hex/tampering', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const body = JSON.stringify({ type: 'ContactCreate' })
    const signature = sign(null, Buffer.from(body, 'utf8'), privateKey).toString('base64')
    expect(verifyGhlSignature(body, signature, pem)).toBe(true)
    expect(verifyGhlSignature(body + ' ', signature, pem)).toBe(false)
    const hex = sign(null, Buffer.from(body, 'utf8'), privateKey).toString('hex')
    expect(verifyGhlSignature(body, hex, pem)).toBe(false)
    const other = generateKeyPairSync('ed25519')
    const otherPem = other.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    expect(verifyGhlSignature(body, signature, otherPem)).toBe(false)
    expect(verifyGhlSignature(body, signature, '')).toBe(false)
    expect(verifyGhlSignature(body, null, pem)).toBe(false)
  })

  it('compares a shared callback token in constant time', () => {
    expect(verifySharedToken('abc', 'abc')).toBe(true)
    expect(verifySharedToken('abd', 'abc')).toBe(false)
    expect(verifySharedToken(null, 'abc')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Adapters: fixed origin, redirect error, byte bound, response-only slots
// ---------------------------------------------------------------------------
describe('GHL adapter', () => {
  it('uses the fixed GHL origin and the v3 header, and parses only returned slots', async () => {
    const { fetch, calls } = capture(JSON.stringify({ '2026-10-06': { slots: ['2026-10-06T14:00:00.000Z'] } }))
    const port: GhlPort = createGhlPort({ fetch })
    const slots = await port.freeSlots('token', { calendarId: 'cal_1', startAt: '2026-10-06T00:00:00Z', endAt: '2026-10-07T00:00:00Z', timezone: 'UTC' }, AbortSignal.timeout(1000))
    expect(calls[0]?.url.startsWith('https://services.leadconnectorhq.com/calendars/cal_1/free-slots?')).toBe(true)
    expect(calls[0]?.init.redirect).toBe('error')
    expect((calls[0]?.init.headers as Record<string, string>).Version).toBe('v3')
    expect(slots).toEqual([{ startAt: '2026-10-06T14:00:00.000Z', endAt: null }])
  })

  it('returns no slots when the provider returns none (never invented availability)', async () => {
    const { fetch } = capture(JSON.stringify({}))
    const port = createGhlPort({ fetch })
    expect(await port.freeSlots('token', { calendarId: 'cal_1', startAt: '2026-10-06T00:00:00Z', endAt: '2026-10-07T00:00:00Z', timezone: 'UTC' }, AbortSignal.timeout(1000))).toEqual([])
  })

  it('parses calendar slotDuration/durationOptions and never invents a default', async () => {
    const { fetch, calls } = capture(JSON.stringify({ calendars: [{ id: 'cal_1', name: 'Sales', slotDuration: 45, slotDurationUnit: 'mins', durationOptions: [{ duration: 45 }, { duration: 60 }] }, { id: 'cal_2', name: 'No duration' }] }))
    const port = createGhlPort({ fetch })
    const calendars = await port.listCalendars('token', 'loc_1', AbortSignal.timeout(1000))
    expect(calls[0]?.url).toContain('https://services.leadconnectorhq.com/calendars/?locationId=loc_1')
    expect(calendars[0]).toMatchObject({ id: 'cal_1', slotDurationMinutes: 45, durationOptions: [45, 60] })
    expect(calendars[1]).toMatchObject({ id: 'cal_2', slotDurationMinutes: null, durationOptions: [] })
  })

  it('gets a single calendar and converts an hours duration to minutes', async () => {
    const { fetch, calls } = capture(JSON.stringify({ calendar: { id: 'cal_1', name: 'Sales', slotDuration: 1, slotDurationUnit: 'hours' } }))
    const port = createGhlPort({ fetch })
    const calendar = await port.getCalendar('token', 'cal_1', AbortSignal.timeout(1000))
    expect(calls[0]?.url).toBe('https://services.leadconnectorhq.com/calendars/cal_1')
    expect(calendar.slotDurationMinutes).toBe(60)
  })

  it('omits endTime when no verified duration exists and sends it when present', async () => {
    const { fetch, calls } = capture(JSON.stringify({ id: 'appt_1', startTime: '2026-10-06T14:00:00.000Z' }), 201)
    const port = createGhlPort({ fetch })
    await port.createAppointment('token', { locationId: 'loc', calendarId: 'cal', contactId: 'c1', startAt: '2026-10-06T14:00:00.000Z', timezone: 'UTC' }, AbortSignal.timeout(1000))
    expect(JSON.parse(String(calls[0]?.init.body))).not.toHaveProperty('endTime')
    await port.createAppointment('token', { locationId: 'loc', calendarId: 'cal', contactId: 'c1', startAt: '2026-10-06T14:00:00.000Z', endAt: '2026-10-06T14:45:00.000Z', timezone: 'UTC' }, AbortSignal.timeout(1000))
    expect(JSON.parse(String(calls[1]?.init.body))).toHaveProperty('endTime', '2026-10-06T14:45:00.000Z')
  })

  it('reschedules with a v3 PUT to the appointment resource', async () => {
    const { fetch, calls } = capture(JSON.stringify({ id: 'appt_1', startTime: '2026-10-07T15:00:00.000Z' }))
    const port = createGhlPort({ fetch })
    const result = await port.rescheduleAppointment('token', { locationId: 'loc', appointmentId: 'appt_1', startAt: '2026-10-07T15:00:00.000Z', timezone: 'UTC' }, AbortSignal.timeout(1000))
    expect(calls[0]?.init.method).toBe('PUT')
    expect(calls[0]?.url).toBe('https://services.leadconnectorhq.com/calendars/events/appointments/appt_1')
    expect(result.appointmentId).toBe('appt_1')
  })

  it('surfaces a provider error without inventing a contact', async () => {
    const { fetch } = capture(JSON.stringify({ message: 'bad' }), 401)
    const port = createGhlPort({ fetch })
    await expect(port.upsertContact('token', { locationId: 'loc', email: 'a@b.test', source: 'x' }, AbortSignal.timeout(1000))).rejects.toMatchObject({ code: 'unauthorized' })
  })

  it('rejects an oversized response body', async () => {
    const { fetch } = capture('x'.repeat(600_000))
    const port = createGhlPort({ fetch })
    await expect(port.check('token', 'loc', AbortSignal.timeout(1000))).rejects.toBeInstanceOf(DownstreamError)
  })
})

describe('Retell adapter', () => {
  it('posts to the fixed Retell origin with a stable idempotency key', async () => {
    const { fetch, calls } = capture(JSON.stringify({ call_id: 'call_abc' }), 201)
    const port: RetellPort = createRetellPort({ fetch })
    const result = await port.createPhoneCall('key', { fromNumber: '+14155550100', toNumber: '+14155550101', idempotencyKey: 'callback-uuid', metadata: { leadId: 'l1' } }, AbortSignal.timeout(1000))
    expect(calls[0]?.url).toBe('https://api.retellai.com/v2/create-phone-call')
    const sent = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>
    expect(sent.idempotency_key).toBe('callback-uuid')
    expect(sent.from_number).toBe('+14155550100')
    expect(result.callId).toBe('call_abc')
  })

  it('reports the documented read-only capability instead of probing with a paid call', () => {
    const port = createRetellPort({ fetch: capture('{}').fetch })
    expect(port.capabilities.readOnlyCheck).toBe('supported')
    expect(port.capabilities.operations).toContain('v2.listPhoneNumbers')
  })

  it('pages through list-phone-numbers with a bounded key and stops at has_more false', async () => {
    const bodies = [
      JSON.stringify({ items: [{ phone_number: '+14155550100', phone_number_type: 'custom', outbound_agents: [{ agent_id: 'agent_1', weight: 1 }] }], has_more: true, pagination_key: 'page-2' }),
      JSON.stringify({ items: [{ phone_number: '+14155550101', phone_number_type: 'retell-twilio' }], has_more: false }),
    ]
    const calls: string[] = []
    let index = 0
    const fetch: typeof globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return fakeResponse(bodies[Math.min(index++, bodies.length - 1)] as string)
    }) as typeof fetch
    const port = createRetellPort({ fetch })
    const result = await port.listPhoneNumbers('key', AbortSignal.timeout(1000))
    expect(calls[0]).toContain('/v2/list-phone-numbers?limit=100')
    expect(calls[1]).toContain('pagination_key=page-2')
    expect(result.pages).toBe(2)
    expect(result.hasMore).toBe(false)
    expect(result.numbers.map((n) => n.phoneNumber)).toEqual(['+14155550100', '+14155550101'])
    expect(result.numbers[0]?.outboundAgentIds).toEqual(['agent_1'])
  })

  it('fetches a single configured phone number read-only', async () => {
    const { fetch, calls } = capture(JSON.stringify({ phone_number: '+14155550999', phone_number_type: 'custom', outbound_agents: [{ agent_id: 'agent_9', weight: 1 }] }))
    const port = createRetellPort({ fetch })
    const number = await port.getPhoneNumber('key', '+14155550999', AbortSignal.timeout(1000))
    expect(calls[0]?.url).toContain('/get-phone-number/%2B14155550999')
    expect(number).toMatchObject({ phoneNumber: '+14155550999', outboundAgentIds: ['agent_9'] })
  })
})

describe('CloseBot adapter', () => {
  it('forwards to the configured source on the fixed CloseBot origin', async () => {
    const { fetch, calls } = capture('{}', 200)
    const port = createCloseBotPort({ fetch })
    await port.sendEvent('cb_key', 'source_1', { contactId: 'l1', body: 'hello' }, AbortSignal.timeout(1000))
    expect(calls[0]?.url).toBe('https://api.closebot.com/webhook/event/source_1')
    expect((calls[0]?.init.headers as Record<string, string>)['X-CB-KEY']).toBe('cb_key')
  })
})

// ---------------------------------------------------------------------------
// Scheduler reservation semantics
// ---------------------------------------------------------------------------
function decisionEvent(decisionId: string): OutreachEventV1 {
  return {
    version: 1,
    organizationId: '00000000-0000-4000-8000-000000000001',
    type: 'conversation.decision.recorded',
    source: 'outreach.agents',
    sourceEventId: decisionId,
    occurredAt: new Date().toISOString(),
    correlationId: '00000000-0000-4000-8000-000000000002',
    causationId: null,
    subject: {},
    data: { decisionId, threadId: '00000000-0000-4000-8000-000000000002', sourceReplyId: '00000000-0000-4000-8000-000000000003', intent: 'interested', approved: true, policyRevision: 1 },
  } as OutreachEventV1
}

function fakeRepository(overrides: Partial<DownstreamRepository> = {}): DownstreamRepository {
  const base = {
    read: vi.fn(),
    mutate: vi.fn(),
    effect: vi.fn(),
    nextOrg: vi.fn(),
    reserveEffect: vi.fn(async () => ({ allowed: true, effectId: 'e1' })),
    settleEffect: vi.fn(),
    claimEffect: vi.fn(),
    effectContext: vi.fn(),
    reserveCallback: vi.fn(),
    settleCallback: vi.fn(),
    recordInboundBridge: vi.fn(),
    recordCrmLink: vi.fn(),
    recordWebhookEvent: vi.fn(),
    recordProviderQualification: vi.fn(),
    connectionSecret: vi.fn(async () => ({ configured: true, enabled: true, revision: 1, credentialCiphertext: 'ciphertext' })),
  } as unknown as DownstreamRepository
  return Object.assign(base, overrides)
}

describe('downstream scheduler helpers', () => {
  it('reads only a well-formed decision id', () => {
    expect(readDecisionId(decisionEvent('00000000-0000-4000-8000-000000000004'))).toBe('00000000-0000-4000-8000-000000000004')
    expect(readDecisionId({ ...decisionEvent('x'), data: {} } as OutreachEventV1)).toBeNull()
  })

  it('reads the canonical source reply the operation is about', () => {
    expect(readSourceReplyId(decisionEvent('00000000-0000-4000-8000-000000000004'))).toBe('00000000-0000-4000-8000-000000000003')
  })

  it('uses a stable logical key independent of config/browser identity', () => {
    const a = effectFingerprint('d1', 'ghl_contact')
    expect(a).toHaveLength(64)
    expect(effectFingerprint('d1', 'ghl_contact')).toBe(a)
    expect(effectFingerprint('d1', 'closebot_forward')).not.toBe(a)
  })

  it('skips disabled providers and reserves a configured effect exactly once', async () => {
    const repository = fakeRepository()
    const deps = { repository, events: {} as DownstreamWorkerDeps['events'], ports: {} as DownstreamWorkerDeps['ports'] }
    const outcome = await reserveDecisionEffects('org', 'decision-1', 'reply-1', deps, Date.now() + 5000)
    expect(outcome.reserved).toBeGreaterThan(0)
    expect(outcome.pending).toBe(0)
    const keys = (repository.reserveEffect as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => (call[1] as Record<string, unknown>).logicalKey)
    expect(keys).toContain('operation:reply-1:ghl_contact')
    expect(keys.every((key) => typeof key === 'string' && key.startsWith('operation:reply-1:'))).toBe(true)
  })

  it('does not reserve anything when no provider is configured', async () => {
    const repository = fakeRepository({ connectionSecret: vi.fn(async () => ({ configured: false })) } as unknown as Partial<DownstreamRepository>)
    const deps = { repository, events: {} as DownstreamWorkerDeps['events'], ports: {} as DownstreamWorkerDeps['ports'] }
    const outcome = await reserveDecisionEffects('org', 'decision-1', 'reply-1', deps, Date.now() + 5000)
    expect(outcome.reserved).toBe(0)
    expect(outcome.pending).toBe(0)
    expect(repository.reserveEffect).not.toHaveBeenCalled()
  })

  it('keeps an approved decision pending for a configured but disabled provider', async () => {
    const repository = fakeRepository({ connectionSecret: vi.fn(async () => ({ configured: true, enabled: false, revision: 1, credentialCiphertext: 'ciphertext' })) } as unknown as Partial<DownstreamRepository>)
    const deps = { repository, events: {} as DownstreamWorkerDeps['events'], ports: {} as DownstreamWorkerDeps['ports'] }
    const outcome = await reserveDecisionEffects('org', 'decision-1', 'reply-1', deps, Date.now() + 5000)
    expect(outcome.reserved).toBe(0)
    expect(outcome.pending).toBeGreaterThan(0)
    expect(repository.reserveEffect).not.toHaveBeenCalled()
  })

  it.each(['not_qualified','contact_not_synced'])('defers an opportunity until its %s prerequisite exists', async (reason) => {
    const repository = fakeRepository({ reserveEffect: vi.fn(async () => ({ allowed: false, reason })) } as unknown as Partial<DownstreamRepository>)
    const deps = { repository, events: {} as DownstreamWorkerDeps['events'], ports: {} as DownstreamWorkerDeps['ports'] }
    const outcome = await reserveDecisionEffects('org', 'decision-1', 'reply-1', deps, Date.now() + 5000)
    expect(outcome.reserved).toBe(0)
    expect(outcome.deferred).toBeGreaterThan(0)
  })

  it('exports the exact 030 decision consumer name', () => {
    expect(DECISION_CONSUMER).toBe('outreach.conversation.decision')
  })

  it('derives the forwarding fingerprint only from the decision id', () => {
    const digest = createHash('sha256').update('d1:ghl_contact').digest('hex')
    expect(effectFingerprint('d1', 'ghl_contact')).toBe(digest)
  })
})

// ---------------------------------------------------------------------------
// Configuration credential material + booking journey (faked storage/ports).
// ---------------------------------------------------------------------------
describe('downstream credential handling and booking journey', () => {
  process.env.ENCRYPTION_SECRET = 'unit-test-secret'
  process.env.ENCRYPTION_SALT = 'unit-test-salt'
  const actor = { userId: 'u1', organizationId: 'o1', role: 'owner' as const }

  it('encrypts the CloseBot inbound token, strips it from config and keeps a blank secret', async () => {
    const existingCipher = encrypt(JSON.stringify({ apiKey: 'cb-key-old' }))
    const mutate = vi.fn<DownstreamRepository['mutate']>(async () => ({ saved: true }))
    const repository = {
      connectionSecret: vi.fn(async () => ({ configured: true, enabled: false, revision: 1, credentialCiphertext: existingCipher, config: { sourceId: 'src_1', inboundToken: 'legacy-plain' } })),
      mutate,
    } as unknown as DownstreamRepository
    const deps = { repository, ports: {} as DownstreamWorkerDeps['ports'] }

    await saveConnection(actor, { provider: 'closebot', expectedRevision: 1, credential: { inboundToken: 'cb-inbound-new' }, config: { sourceId: '' } }, deps)
    const payload = mutate.mock.calls[0]?.[2] as Record<string, unknown>
    expect(payload.config).toEqual({ sourceId: 'src_1' })
    expect(JSON.stringify(payload)).not.toContain('cb-inbound-new')
    expect(JSON.stringify(payload.config)).not.toContain('legacy-plain')
    const decrypted = JSON.parse(decrypt(String(payload.ciphertext))) as Record<string, string>
    expect(decrypted).toEqual({ apiKey: 'cb-key-old', inboundToken: 'cb-inbound-new' })

    // A blank inbound token keeps the stored credential (no re-encryption).
    mutate.mockClear()
    await saveConnection(actor, { provider: 'closebot', expectedRevision: 2, credential: { inboundToken: '' }, config: { sourceId: 'src_1' } }, deps)
    expect(mutate.mock.calls[0]?.[2]).not.toHaveProperty('ciphertext')
  })

  it('rejects a slot the provider no longer offers and never writes to the provider', async () => {
    const ciphertext = encrypt(JSON.stringify({ apiKey: 'ghl-key' }))
    const createAppointment = vi.fn()
    const repository = {
      connectionSecret: vi.fn(async () => ({ configured: true, enabled: true, revision: 2, credentialCiphertext: ciphertext, config: { locationId: 'loc_1' } })),
      reserveAppointment: vi.fn(),
      settleAppointment: vi.fn(),
    } as unknown as DownstreamRepository
    const ports = {
      ghl: {
        listCalendars: vi.fn(async () => [{ id: 'cal_1', name: 'Sales', slotDurationMinutes: 30, durationOptions: [] }]),
        getCalendar: vi.fn(async () => ({ id: 'cal_1', name: 'Sales', slotDurationMinutes: 30, durationOptions: [] })),
        freeSlots: vi.fn(async () => [{ startAt: '2026-10-06T15:00:00.000Z', endAt: null }]),
        createAppointment,
      },
    } as unknown as DownstreamWorkerDeps['ports']
    const result = await requestAppointment(actor, { leadId: '00000000-0000-4000-8000-000000000010', calendarId: 'cal_1', startAt: '2026-10-06T14:00:00.000Z', timezone: 'UTC' }, { repository, ports })
    expect(result).toMatchObject({ allowed: false, reason: 'slot_unavailable' })
    expect(createAppointment).not.toHaveBeenCalled()
  })

  it('reserves durably and confirms with exactly one provider write', async () => {
    const ciphertext = encrypt(JSON.stringify({ apiKey: 'ghl-key' }))
    const repository = {
      connectionSecret: vi.fn(async () => ({ configured: true, enabled: true, revision: 2, credentialCiphertext: ciphertext, config: { locationId: 'loc_1' } })),
      reserveAppointment: vi.fn(async () => ({ allowed: true, appointmentId: 'appt-row', status: 'reserved', crmContactId: 'ghl_contact_1' })),
      settleAppointment: vi.fn(async () => undefined),
      effect: vi.fn(async (_org,action) => action==='beginWrite' ? {allowed:true,writeId:'write-1',writeToken:'token-1'} : {allowed:true}),
    } as unknown as DownstreamRepository
    const createAppointment = vi.fn<GhlPort['createAppointment']>(async () => ({ appointmentId: 'ghl_appt_1', receipt: { appointmentId: 'ghl_appt_1', startTime: '2026-10-06T14:00:00.000Z', endTime: '2026-10-06T14:30:00.000Z' } }))
    const ports = {
      ghl: {
        listCalendars: vi.fn(async () => [{ id: 'cal_1', name: 'Sales', slotDurationMinutes: 30, durationOptions: [] }]),
        getCalendar: vi.fn(async () => ({ id: 'cal_1', name: 'Sales', slotDurationMinutes: 30, durationOptions: [] })),
        freeSlots: vi.fn(async () => [{ startAt: '2026-10-06T14:00:00.000Z', endAt: null }]),
        createAppointment,
      },
    } as unknown as DownstreamWorkerDeps['ports']
    const result = await requestAppointment(actor, { leadId: '00000000-0000-4000-8000-000000000010', calendarId: 'cal_1', startAt: '2026-10-06T14:00:00.000Z', timezone: 'UTC' }, { repository, ports })
    expect(result).toMatchObject({ allowed: true, status: 'scheduled', providerAppointmentId: 'ghl_appt_1', endsAt: '2026-10-06T14:30:00.000Z' })
    expect(createAppointment).toHaveBeenCalledTimes(1)
    const sent = createAppointment.mock.calls[0]?.[1]
    expect(sent).toMatchObject({ contactId: 'ghl_contact_1', endAt: '2026-10-06T14:30:00.000Z' })
    expect(repository.reserveAppointment).toHaveBeenCalledTimes(1)
    expect(repository.settleAppointment).toHaveBeenCalledTimes(1)
  })
})

describe('downstream final provider handoff contracts',()=>{
 const actor={userId:'owner',organizationId:'org',role:'owner' as const}
 function credential(){process.env.ENCRYPTION_SECRET='unit-test-secret';process.env.ENCRYPTION_SALT='unit-test-salt';return encrypt(JSON.stringify({apiKey:'synthetic-key'}))}
 it('does not call Retell after the final database authorization refuses the reserved call',async()=>{
  const createPhoneCall=vi.fn();const effect=vi.fn(async(_org,action)=>action==='beginWrite'?{allowed:true,writeId:'write',writeToken:'token'}:{allowed:false})
  const repository={connectionSecret:vi.fn(async()=>({configured:true,enabled:true,revision:2,credentialCiphertext:credential(),config:{fromNumber:'+14155550999'}})),reserveCallback:vi.fn(async()=>({allowed:true,callbackId:'callback',phoneE164:'+14155550100'})),effect} as unknown as DownstreamRepository
  const deps={repository,ports:{retell:{createPhoneCall}}} as unknown as DownstreamWorkerDeps
  expect(await initiateRequestedCallback(actor,'eligibility',deps)).toMatchObject({allowed:false,reason:'authorization_changed'})
  expect(createPhoneCall).not.toHaveBeenCalled();expect(effect.mock.calls.map(call=>call[1])).toEqual(['beginWrite','authorizeWrite'])
 })
 it('requires a final single-use grant before forwarding a ready CloseBot body',async()=>{
  const sendEvent=vi.fn();const repository={effectContext:vi.fn(async()=>({found:true,effect:{effect_kind:'closebot_forward',connection_revision:2,decision_id:'decision'},connectionRevision:2,connectionEnabled:true,credentialCiphertext:credential(),config:{sourceId:'source'},decision:{approved:true,threadId:'thread',sourceReplyId:'reply'},lead:{leadId:'lead'},bodyReady:true,replyBody:'Ready body'})),effect:vi.fn(async()=>({allowed:false}))} as unknown as DownstreamRepository
  await executeReservedEffect('org','effect','token',{repository,ports:{closebot:{sendEvent}}} as unknown as DownstreamWorkerDeps,Date.now()+10000)
  expect(sendEvent).not.toHaveBeenCalled()
 })
 it('refuses a provider read when the absolute request deadline has already expired',async()=>{
  const list=vi.fn();const repository={connectionSecret:vi.fn(async()=>({configured:true,enabled:true,revision:2,credentialCiphertext:credential(),config:{locationId:'location'}}))} as unknown as DownstreamRepository
  await expect(listCalendars(actor,{repository,ports:{ghl:{listCalendars:list}} as unknown as DownstreamWorkerDeps['ports']},Date.now()-1)).rejects.toThrow('deadline expired')
  expect(list).not.toHaveBeenCalled()
 })
 it('records no successful Retell check without an outbound agent binding',async()=>{
  const mutate=vi.fn(async(_actor,_action,payload)=>payload)
  const repository={connectionSecret:vi.fn(async()=>({configured:true,enabled:true,revision:2,credentialCiphertext:credential(),config:{fromNumber:'+14155550999'}})),mutate} as unknown as DownstreamRepository
  const ports={retell:{capabilities:{readOnlyCheck:'supported',operations:[]},listPhoneNumbers:vi.fn(async()=>({numbers:[{phoneNumber:'+14155550999',outboundAgentIds:[]}],hasMore:false,pages:1})),getPhoneNumber:vi.fn(async()=>({phoneNumber:'+14155550999',outboundAgentIds:[]}))}} as unknown as DownstreamWorkerDeps['ports']
  const result=await checkConnection(actor,{provider:'retell',expectedRevision:2},{repository,ports});expect(result).toMatchObject({ok:false,detail:'outbound_agent_not_bound'})
 })
 it('keeps an accepted cancellation unknown when its receipt cannot be persisted',async()=>{
  const cancel=vi.fn(async()=>({receipt:{deleted:true}}));const settle=vi.fn<DownstreamRepository['settleAppointment']>(async()=>{throw Error('Receipt lost')})
  const repository={read:vi.fn(async()=>({appointments:[{id:'appointment',provider_appointment_id:'provider-appointment',status:'scheduled'}]})),connectionSecret:vi.fn(async()=>({configured:true,enabled:true,revision:2,credentialCiphertext:credential(),config:{locationId:'location'}})),effect:vi.fn(async(_org,action)=>action==='beginWrite'?{allowed:true,writeId:'write',writeToken:'token'}:{allowed:true}),settleAppointment:settle} as unknown as DownstreamRepository
  const result=await cancelAppointment(actor,{appointmentId:'appointment'},{repository,ports:{ghl:{cancelAppointment:cancel}} as unknown as DownstreamWorkerDeps['ports']})
  expect(cancel).toHaveBeenCalledTimes(1);expect(result).toMatchObject({allowed:false,status:'unknown'});expect(settle.mock.calls[1]?.[1]).toMatchObject({status:'unknown',writeId:'write',writeToken:'token'})
 })
})


describe('complete downstream body deadlines', () => {
  it('aborts a stalled provider body after headers without awaiting cancellation', async () => {
    const controller = new AbortController()
    const cancel = vi.fn(() => new Promise<void>(() => undefined))
    const response = {
      status: 200, headers: new Headers(),
      body: { getReader: () => ({ read: () => new Promise(() => undefined), cancel, releaseLock: () => undefined }) },
    } as unknown as Response
    const port = createRetellPort({ fetch: vi.fn(async () => response) })
    const result = port.listPhoneNumbers('synthetic', controller.signal)
    controller.abort()
    await expect(result).rejects.toMatchObject({ code: 'aborted' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('refuses a stalled incoming webhook body when its request is aborted', async () => {
    const controller = new AbortController()
    const cancel = vi.fn(() => new Promise<void>(() => undefined))
    const request = {
      signal: controller.signal, headers: new Headers(),
      body: { getReader: () => ({ read: () => new Promise(() => undefined), cancel, releaseLock: () => undefined }) },
    } as unknown as Request
    const result = readBoundedRequestBody(request)
    controller.abort()
    await expect(result).resolves.toBeNull()
    expect(cancel).toHaveBeenCalledOnce()
  })
})
