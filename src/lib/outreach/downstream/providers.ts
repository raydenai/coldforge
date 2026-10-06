/**
 * Provider adapters for the bounded downstream module.
 *
 * Every adapter uses a fixed origin, a bounded/timeout fetch, and an explicit
 * error taxonomy. No adapter fetches a caller-supplied callback URL. Signature
 * verification uses Node's native crypto; no new dependency is added.
 *
 * Primary sources (retrieved 2026-10-05):
 *  - GHL v3: https://marketplace.gohighlevel.com/docs/ghl/contacts/upsert-contact/index.html
 *    and .../calendars/get-slots/index.html (header `Version: v3`, bearer token).
 *  - CloseBot: https://developers.closebot.com/api-reference/webhook/send-a-webhook-event.md
 *    (`POST /webhook/event/{sourceId}`, header `X-CB-KEY`) and
 *    https://docs.closebot.com/en/articles/16358483-custom-blank-source-channel-webhook
 *  - Retell: https://docs.retellai.com/api-references/create-phone-call.md
 *    (`POST /v2/create-phone-call`) and https://docs.retellai.com/features/secure-webhook.md
 */
import { createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify, type KeyObject } from 'node:crypto'
import {
  CLOSEBOT_ORIGIN,
  GHL_ORIGIN,
  GHL_WEBHOOK_PUBLIC_KEY_PEM,
  MAX_WEBHOOK_BYTES,
  RETELL_MAX_PAGES,
  RETELL_ORIGIN,
  RETELL_PAGE_LIMIT,
  DownstreamError,
  type CloseBotPort,
  type GhlAppointmentInput,
  type GhlAppointmentResult,
  type GhlCalendar,
  type GhlContactInput,
  type GhlContactResult,
  type GhlOpportunityInput,
  type GhlOpportunityResult,
  type GhlPort,
  type GhlRescheduleInput,
  type GhlSlot,
  type ProviderCapabilities,
  type RetellPhoneNumber,
  type RetellPort,
} from './core'

const MAX_RESPONSE_BYTES = 512 * 1024
const REQUEST_TIMEOUT_MS = 12_000

/** Race every body read against the absolute request deadline, including after headers. */
function beforeAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(new DownstreamError('aborted', 'Provider body deadline exceeded', true))
    }
    pending.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** Bounded read: a late or oversized body aborts rather than being buffered. */
async function readBounded(response: Response, signal: AbortSignal): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new DownstreamError('response_too_large', 'Provider response exceeded the byte bound')
  }
  const reader = response.body?.getReader()
  if (!reader) {
    const text = await beforeAbort(response.text(), signal)
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new DownstreamError('response_too_large', 'Provider response exceeded the byte bound')
    return text
  }
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      if (signal.aborted) throw new DownstreamError('aborted', 'Provider request was aborted', true)
      const { done, value } = await beforeAbort(reader.read(), signal)
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > MAX_RESPONSE_BYTES) {
          void reader.cancel().catch(() => undefined)
          throw new DownstreamError('response_too_large', 'Provider response exceeded the byte bound')
        }
        chunks.push(value)
      }
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined)
    throw error
  } finally {
    try { reader.releaseLock() } catch { /* Cancellation may still be settling a pending read. */ }
  }
  return Buffer.concat(chunks).toString('utf8')
}

export interface AdapterDeps {
  fetch?: typeof fetch
}

/**
 * Bounded raw-body read for webhooks. The body is captured before any auth,
 * parsing or signature verification and refuses to buffer more than
 * `maxBytes`; an oversized request fails closed instead of growing memory.
 */
export async function readBoundedRequestBody(request: Request, maxBytes = MAX_WEBHOOK_BYTES): Promise<string | null> {
  const declared = Number(request.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) return null
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(10_000)])
  const body = request.body
  if (!body) return ''
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await beforeAbort(reader.read(), signal)
      if (done) break
      if (value) {
        total += value.byteLength
        if (total > maxBytes) {
          void reader.cancel().catch(() => undefined)
          return null
        }
        chunks.push(value)
      }
    }
  } catch {
    void reader.cancel().catch(() => undefined)
    return null
  } finally {
    try { reader.releaseLock() } catch { /* Cancellation may still be settling a pending read. */ }
  }
  return Buffer.concat(chunks).toString('utf8')
}

function makeFetch(override?: typeof fetch): typeof fetch {
  return override ?? ((input, init) => fetch(input, init))
}

async function requestJson(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  context: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const combined = AbortSignal.any([signal, timeout])
  let response: Response
  try {
    response = await doFetch(url, { ...init, signal: combined, redirect: 'error' })
  } catch {
    if (signal.aborted) throw new DownstreamError('aborted', `${context} request was aborted`, true)
    throw new DownstreamError('network_error', `${context} request failed`, true)
  }
  const text = await readBounded(response, combined)
  let body: Record<string, unknown> = {}
  if (text.length > 0) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>
      else body = { value: parsed }
    } catch {
      throw new DownstreamError('invalid_response', `${context} returned a non-JSON body`)
    }
  }
  if (response.status >= 200 && response.status < 300) return { status: response.status, body }
  const retryable = response.status === 429 || response.status >= 500
  const code = response.status === 401 || response.status === 403 ? 'unauthorized' : response.status === 429 ? 'rate_limited' : 'provider_error'
  throw new DownstreamError(code, `${context} returned ${response.status}`, retryable)
}

// ---------------------------------------------------------------------------
// Retell webhook signature (HMAC-SHA256 over raw body + timestamp).
// ---------------------------------------------------------------------------
export function verifyRetellSignature(rawBody: string, header: string | null, apiKey: string, nowMs = Date.now()): boolean {
  if (!header || !apiKey) return false
  const match = /^v=(\d+),d=([0-9a-fA-F]+)$/.exec(header.trim())
  if (!match) return false
  const timestamp = match[1]
  const digest = match[2]
  if (timestamp === undefined || digest === undefined) return false
  const sent = Number.parseInt(timestamp, 10)
  if (!Number.isFinite(sent) || Math.abs(nowMs - sent) > 5 * 60 * 1000) return false
  const expected = createHmac('sha256', apiKey).update(rawBody + timestamp).digest()
  let provided: Buffer
  try {
    provided = Buffer.from(digest, 'hex')
  } catch {
    return false
  }
  if (provided.length !== expected.length) return false
  return timingSafeEqual(provided, expected)
}

// ---------------------------------------------------------------------------
// GHL webhook signature (Ed25519, `X-GHL-Signature`). The official public key
// is a constant published by GHL; a tenant cannot supply its own key. The
// header is base64 of the Ed25519 signature over the raw UTF-8 body. The
// legacy RSA header is intentionally not accepted.
// Source: https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide/index.html
// ---------------------------------------------------------------------------
export function verifyGhlSignature(rawBody: string, header: string | null, publicKeyPem = GHL_WEBHOOK_PUBLIC_KEY_PEM): boolean {
  if (!header || !publicKeyPem) return false
  let key: KeyObject
  try {
    key = createPublicKey(publicKeyPem)
  } catch {
    return false
  }
  let signature: Buffer
  try {
    signature = Buffer.from(header.trim(), 'base64')
  } catch {
    return false
  }
  if (signature.length === 0) return false
  try {
    return cryptoVerify(null, Buffer.from(rawBody, 'utf8'), key, signature)
  } catch {
    return false
  }
}

/** Constant-time shared-token comparison for the CloseBot callback token. */
export function verifySharedToken(provided: string | null, expected: string): boolean {
  if (!provided || !expected) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Extract the raw bearer/API secret from a decrypted credential blob. */
export function extractCredentialSecret(raw: string): string {
  const record = parseCredentialBlob(raw)
  if (record) {
    const candidate = record.token ?? record.apiKey ?? record.accessToken ?? record.api_key ?? record.apiKey
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return raw
}

/** Extract the CloseBot inbound callback token (credential material). */
export function extractInboundToken(raw: string): string {
  const record = parseCredentialBlob(raw)
  const candidate = record?.inboundToken
  return typeof candidate === 'string' ? candidate : ''
}

function parseCredentialBlob(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // plain string secret
  }
  return null
}

// ---------------------------------------------------------------------------
// GHL adapter
// ---------------------------------------------------------------------------
const GHL_CAPABILITIES: ProviderCapabilities = {
  provider: 'ghl',
  readOnlyCheck: 'supported',
  operations: [
    'contacts.upsert',
    'opportunities.upsert',
    'calendars.list',
    'calendars.get',
    'calendars.freeSlots',
    'appointments.create',
    'appointments.reschedule',
    'appointments.cancel',
  ],
}

function ghlHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Version: 'v3', 'Content-Type': 'application/json', Accept: 'application/json' }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Parse a GHL v3 calendar object without inventing a duration. */
function parseCalendar(value: unknown): GhlCalendar | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const id = asString(record.id)
  if (!id) return null
  const rawDuration = typeof record.slotDuration === 'number' ? record.slotDuration : null
  const unit = asString(record.slotDurationUnit) ?? 'mins'
  const slotDurationMinutes =
    rawDuration !== null && rawDuration > 0 ? (unit === 'hours' ? rawDuration * 60 : rawDuration) : null
  const durationOptions: number[] = []
  if (Array.isArray(record.durationOptions)) {
    for (const option of record.durationOptions) {
      const minutes = option !== null && typeof option === 'object' ? (option as Record<string, unknown>).duration : null
      if (typeof minutes === 'number' && minutes > 0) durationOptions.push(minutes)
    }
  }
  return { id, name: asString(record.name) ?? id, slotDurationMinutes, durationOptions }
}

export function createGhlPort(deps: AdapterDeps = {}): GhlPort {
  const doFetch = makeFetch(deps.fetch)
  return {
    capabilities: GHL_CAPABILITIES,
    async check(token, locationId, signal) {
      const url = `${GHL_ORIGIN}/calendars/?locationId=${encodeURIComponent(locationId)}`
      const { body } = await requestJson(doFetch, url, { method: 'GET', headers: ghlHeaders(token) }, signal, 'ghl.calendars')
      const calendars = Array.isArray(body.calendars) ? body.calendars.length : 0
      return { calendars }
    },
    async listCalendars(token, locationId, signal): Promise<GhlCalendar[]> {
      const url = `${GHL_ORIGIN}/calendars/?locationId=${encodeURIComponent(locationId)}`
      const { body } = await requestJson(doFetch, url, { method: 'GET', headers: ghlHeaders(token) }, signal, 'ghl.calendars.list')
      const raw = Array.isArray(body.calendars) ? body.calendars : []
      return raw.map(parseCalendar).filter((calendar): calendar is GhlCalendar => calendar !== null)
    },
    async getCalendar(token, calendarId, signal): Promise<GhlCalendar> {
      const url = `${GHL_ORIGIN}/calendars/${encodeURIComponent(calendarId)}`
      const { body } = await requestJson(doFetch, url, { method: 'GET', headers: ghlHeaders(token) }, signal, 'ghl.calendars.get')
      const calendar = parseCalendar(body.calendar ?? body)
      if (!calendar) throw new DownstreamError('invalid_response', 'GHL get-calendar returned no calendar duration')
      return calendar
    },
    async upsertContact(token, input: GhlContactInput, signal): Promise<GhlContactResult> {
      const payload: Record<string, unknown> = {
        locationId: input.locationId,
        email: input.email,
        source: input.source,
      }
      if (input.firstName) payload.firstName = input.firstName
      if (input.lastName) payload.lastName = input.lastName
      if (input.phone) payload.phone = input.phone
      const { body } = await requestJson(doFetch, `${GHL_ORIGIN}/contacts/upsert`, { method: 'POST', headers: ghlHeaders(token), body: JSON.stringify(payload) }, signal, 'ghl.contacts.upsert')
      const contact = body.contact
      const contactId = contact !== null && typeof contact === 'object' ? asString((contact as Record<string, unknown>).id) : null
      if (!contactId) throw new DownstreamError('invalid_response', 'GHL upsert returned no contact id')
      return { contactId, created: body.new === true }
    },
    async upsertOpportunity(token, input: GhlOpportunityInput, signal): Promise<GhlOpportunityResult> {
      const payload: Record<string, unknown> = {
        locationId: input.locationId,
        pipelineId: input.pipelineId,
        contactId: input.contactId,
        name: input.name,
        status: input.status,
      }
      if (input.monetaryValue !== undefined) payload.monetaryValue = input.monetaryValue
      const { body } = await requestJson(doFetch, `${GHL_ORIGIN}/opportunities/upsert`, { method: 'POST', headers: ghlHeaders(token), body: JSON.stringify(payload) }, signal, 'ghl.opportunities.upsert')
      const opportunity = body.opportunity
      const opportunityId =
        opportunity !== null && typeof opportunity === 'object' ? asString((opportunity as Record<string, unknown>).id) : null
      if (!opportunityId) throw new DownstreamError('invalid_response', 'GHL opportunity upsert returned no id')
      return { opportunityId }
    },
    async freeSlots(token, input, signal): Promise<GhlSlot[]> {
      const query = new URLSearchParams({
        startDate: String(Date.parse(input.startAt)),
        endDate: String(Date.parse(input.endAt)),
        timezone: input.timezone,
      })
      const url = `${GHL_ORIGIN}/calendars/${encodeURIComponent(input.calendarId)}/free-slots?${query.toString()}`
      const { body } = await requestJson(doFetch, url, { method: 'GET', headers: ghlHeaders(token) }, signal, 'ghl.calendars.freeSlots')
      // Real API shape: { "<YYYY-MM-DD>": { slots: ["<iso>", ...] }, ... }.
      // Only starts actually returned by the provider are surfaced; the end is
      // never synthesized here (the verified calendar duration is applied by
      // the caller, or omitted when unknown).
      const slots: GhlSlot[] = []
      for (const [date, value] of Object.entries(body)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
        const entry = value as Record<string, unknown>
        const raw = Array.isArray(entry?.slots) ? entry.slots : []
        for (const slot of raw) {
          const startAt = asString(slot)
          if (!startAt) continue
          slots.push({ startAt, endAt: null })
        }
      }
      return slots.sort((a, b) => a.startAt.localeCompare(b.startAt))
    },
    async createAppointment(token, input: GhlAppointmentInput, signal): Promise<GhlAppointmentResult> {
      const payload: Record<string, unknown> = {
        calendarId: input.calendarId,
        locationId: input.locationId,
        contactId: input.contactId,
        startTime: input.startAt,
        timezone: input.timezone,
      }
      // Send endTime only when a verified duration produced one.
      if (input.endAt) payload.endTime = input.endAt
      const { body } = await requestJson(doFetch, `${GHL_ORIGIN}/calendars/events/appointments`, { method: 'POST', headers: ghlHeaders(token), body: JSON.stringify(payload) }, signal, 'ghl.appointments.create')
      const appointmentId = asString(body.id) ?? asString(body.appointmentId)
      if (!appointmentId) throw new DownstreamError('invalid_response', 'GHL appointment create returned no id')
      return { appointmentId, receipt: { appointmentId, startTime: asString(body.startTime), endTime: asString(body.endTime), locationId: asString(body.locationId) ?? input.locationId } }
    },
    async rescheduleAppointment(token, input: GhlRescheduleInput, signal) {
      const payload: Record<string, unknown> = { startTime: input.startAt, timezone: input.timezone, locationId: input.locationId }
      if (input.endAt) payload.endTime = input.endAt
      const { body } = await requestJson(
        doFetch,
        `${GHL_ORIGIN}/calendars/events/appointments/${encodeURIComponent(input.appointmentId)}`,
        { method: 'PUT', headers: ghlHeaders(token), body: JSON.stringify(payload) },
        signal,
        'ghl.appointments.reschedule',
      )
      const appointmentId = asString(body.id) ?? asString(body.appointmentId) ?? input.appointmentId
      return { appointmentId, receipt: { appointmentId, startTime: asString(body.startTime), endTime: asString(body.endTime) } }
    },
    async cancelAppointment(token, appointmentId, signal) {
      const { body } = await requestJson(doFetch, `${GHL_ORIGIN}/calendars/events/appointments/${encodeURIComponent(appointmentId)}`, { method: 'DELETE', headers: ghlHeaders(token) }, signal, 'ghl.appointments.cancel')
      return { cancelled: true, receipt: { deleted: body.deleted === true } }
    },
  }
}

// ---------------------------------------------------------------------------
// CloseBot adapter
// ---------------------------------------------------------------------------
const CLOSEBOT_CAPABILITIES: ProviderCapabilities = {
  provider: 'closebot',
  readOnlyCheck: 'supported',
  operations: ['sources.list', 'webhook.event.send'],
}

export function createCloseBotPort(deps: AdapterDeps = {}): CloseBotPort {
  const doFetch = makeFetch(deps.fetch)
  return {
    capabilities: CLOSEBOT_CAPABILITIES,
    async check(apiKey, signal) {
      const { body } = await requestJson(doFetch, `${CLOSEBOT_ORIGIN}/source`, { method: 'GET', headers: { 'X-CB-KEY': apiKey } }, signal, 'closebot.sources')
      const sources = Array.isArray(body) ? body.length : Array.isArray(body.sources) ? body.sources.length : 0
      return { sources }
    },
    async sendEvent(apiKey, sourceId, event, signal) {
      const { status, body } = await requestJson(
        doFetch,
        `${CLOSEBOT_ORIGIN}/webhook/event/${encodeURIComponent(sourceId)}`,
        { method: 'POST', headers: { 'X-CB-KEY': apiKey, 'Content-Type': 'application/json' }, body: JSON.stringify(event) },
        signal,
        'closebot.webhook.event',
      )
      return { accepted: status >= 200 && status < 300, receipt: body }
    },
  }
}

// ---------------------------------------------------------------------------
// Retell adapter
// ---------------------------------------------------------------------------
const RETELL_CAPABILITIES: ProviderCapabilities = {
  provider: 'retell',
  // Documented read-only probes exist: list-phone-numbers and get-phone-number.
  readOnlyCheck: 'supported',
  operations: ['v2.listPhoneNumbers', 'v2.getPhoneNumber', 'v2.createPhoneCall'],
}

function parseRetellNumber(value: unknown): RetellPhoneNumber | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const phoneNumber = asString(record.phone_number) ?? asString(record.phoneNumber)
  if (!phoneNumber) return null
  const agentIds = (list: unknown): string[] =>
    Array.isArray(list)
      ? list
          .map((entry) => (entry !== null && typeof entry === 'object' ? asString((entry as Record<string, unknown>).agent_id) : null))
          .filter((id): id is string => id !== null)
      : []
  return {
    phoneNumber,
    phoneNumberType: asString(record.phone_number_type) ?? asString(record.phoneNumberType),
    inboundAgentIds: agentIds(record.inbound_agents ?? record.inboundAgents),
    outboundAgentIds: agentIds(record.outbound_agents ?? record.outboundAgents),
    nickname: asString(record.nickname),
  }
}

export function createRetellPort(deps: AdapterDeps = {}): RetellPort {
  const doFetch = makeFetch(deps.fetch)
  const headers = (apiKey: string) => ({ Authorization: `Bearer ${apiKey}`, Accept: 'application/json' })
  return {
    capabilities: RETELL_CAPABILITIES,
    async listPhoneNumbers(apiKey, signal) {
      const numbers: RetellPhoneNumber[] = []
      let paginationKey: string | null = null
      let pages = 0
      let hasMore = false
      for (let page = 0; page < RETELL_MAX_PAGES; page += 1) {
        const query = new URLSearchParams({ limit: String(RETELL_PAGE_LIMIT) })
        if (paginationKey) query.set('pagination_key', paginationKey)
        const { body } = await requestJson(
          doFetch,
          `${RETELL_ORIGIN}/v2/list-phone-numbers?${query.toString()}`,
          { method: 'GET', headers: headers(apiKey) },
          signal,
          'retell.listPhoneNumbers',
        )
        pages += 1
        const items = Array.isArray(body.items) ? body.items : []
        for (const item of items) {
          const parsed = parseRetellNumber(item)
          if (parsed) numbers.push(parsed)
        }
        hasMore = body.has_more === true
        const next = asString(body.pagination_key)
        if (!hasMore || !next) break
        paginationKey = next
      }
      return { numbers, hasMore, pages }
    },
    async getPhoneNumber(apiKey, phoneNumber, signal) {
      const { body } = await requestJson(
        doFetch,
        `${RETELL_ORIGIN}/get-phone-number/${encodeURIComponent(phoneNumber)}`,
        { method: 'GET', headers: headers(apiKey) },
        signal,
        'retell.getPhoneNumber',
      )
      return parseRetellNumber(body)
    },
    async createPhoneCall(apiKey, input, signal) {
      const payload = {
        from_number: input.fromNumber,
        to_number: input.toNumber,
        idempotency_key: input.idempotencyKey,
        metadata: input.metadata,
      }
      const { status, body } = await requestJson(
        doFetch,
        `${RETELL_ORIGIN}/v2/create-phone-call`,
        { method: 'POST', headers: { ...headers(apiKey), 'Content-Type': 'application/json' }, body: JSON.stringify(payload) },
        signal,
        'retell.createPhoneCall',
      )
      const callId = asString(body.call_id)
      if (!callId) throw new DownstreamError('invalid_response', 'Retell create-phone-call returned no call_id')
      return { callId, receipt: { status, callId } }
    },
  }
}
