/**
 * Typed Winnr HTTP adapter.
 *
 * Security and truthfulness rules enforced here (launch plan Task 2):
 *   - Requests go only to the fixed production origin; redirects are rejected.
 *   - Every wire response is parsed with Zod, unknown fields stripped, and only
 *     normalized records leave this module. Provider credentials, raw provider
 *     failure text, tokens and URLs never reach callers or logs.
 *   - GET may retry once with a bounded wait. Mutations are never retried.
 *   - A mutation with an uncertain outcome (timeout, network failure, 5xx,
 *     malformed success, redirect, uncertain 4xx) throws a `WinnrError` with
 *     `outcomeUnknown: true` — never a silent success.
 *   - Ids used in paths are validated and component-encoded; slash, dotpath
 *     and whitespace ids are rejected before any request.
 *
 * Wire contracts: `https://app.winnr.app/openapi.yaml` (downloaded 2026-10-05,
 * SHA256 675267d3d22d098b73ee5379570bd0e6badaac326e7a3e4229822e9f13c1e994).
 */
import { z } from 'zod'
import type {
  CursorPage,
  Domain,
  InboxMessage,
  ListDomainsParams,
  ListInboxParams,
  ListMailboxesParams,
  ListWarmingParams,
  Mailbox,
  SendMessageInput,
  SendResult,
  WarmingMailbox,
  WarmingMetric,
  WarmingPage,
  WinnrAccount,
  WinnrSettings,
} from './types'

const BASE_URL = 'https://api.winnr.app'
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_READ_ATTEMPTS = 2
const RETRY_DELAY_MS = 100
const MAX_CURSOR_LIMIT = 100
const MAX_ACCOUNT_INBOX_LIMIT = 200
const MAX_WARMING_PER_PAGE = 500

/** 4xx statuses whose outcome is ambiguous enough to treat conservatively. */
const UNCERTAIN_STATUSES = new Set([408, 410, 425])

type HttpMethod = 'GET' | 'POST'
type Query = Record<string, string | number | undefined>

export interface WinnrClientOptions {
  token: string
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch
  timeoutMs?: number
  /**
   * Optional caller cancellation (for example a remaining request budget).
   * Combined with, never replacing, the client's own timeout signal.
   */
  signal?: AbortSignal
}

export interface WinnrClient {
  getAccount(): Promise<WinnrAccount>
  listMailboxes(params?: ListMailboxesParams): Promise<CursorPage<Mailbox>>
  listDomains(params?: ListDomainsParams): Promise<CursorPage<Domain>>
  listWarming(params?: ListWarmingParams): Promise<WarmingPage>
  getWarmingMetrics(mailboxId: string): Promise<WarmingMetric[]>
  enableWarming(ids: string[], settings: WinnrSettings): Promise<WarmingMailbox[]>
  pauseWarming(id: string): Promise<void>
  resumeWarming(id: string): Promise<void>
  disableWarming(ids: string[]): Promise<void>
  listInbox(params?: ListInboxParams): Promise<CursorPage<InboxMessage>>
  sendMessage(input: SendMessageInput): Promise<SendResult>
}

/**
 * Typed Winnr failure. `outcomeUnknown` is true whenever a mutation may have
 * landed at the provider but we could not confirm it; callers must hold and
 * reconcile rather than replay.
 */
export class WinnrError extends Error {
  readonly status: number
  readonly code: string
  readonly outcomeUnknown: boolean
  readonly retryAfterSeconds: number | null

  constructor(
    message: string,
    options: {
      status?: number
      code?: string
      outcomeUnknown?: boolean
      retryAfterSeconds?: number | null
    } = {}
  ) {
    super(message)
    this.name = 'WinnrError'
    this.status = options.status ?? 0
    this.code = options.code ?? 'winnr_error'
    this.outcomeUnknown = options.outcomeUnknown ?? false
    this.retryAfterSeconds = options.retryAfterSeconds ?? null
  }
}

// ---------------------------------------------------------------------------
// Wire schemas (unknown fields stripped by Zod objects by default)
// ---------------------------------------------------------------------------

const paginationSchema = z.object({
  has_more: z.boolean().optional(),
  cursor: z.string().nullish(),
  count: z.number().optional(),
  total: z.number().optional(),
  page: z.number().optional(),
  per_page: z.number().optional(),
})

const accountDataSchema = z.object({
  id: z.string(),
  name: z.string(),
  plan: z.string().nullish(),
  universal_inbox_enabled: z.boolean().optional(),
  api_token: z
    .object({
      permissions: z.array(z.string()).optional(),
    })
    .nullish(),
})
const accountEnvelopeSchema = z.object({ data: accountDataSchema })

const mailboxDataSchema = z.object({
  id: z.string(),
  full_address: z.string(),
  name: z.string().nullish(),
  status: z.enum(['active', 'paused', 'disabled']),
  daily_send_limit: z.number().nullish(),
})
const mailboxListEnvelopeSchema = z.object({
  data: z.array(mailboxDataSchema),
  pagination: paginationSchema.optional(),
})

const domainDataSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['pending', 'complete', 'deleting', 'active']),
  dns_health: z
    .object({
      status: z.enum(['healthy', 'degraded', 'failing']).nullish(),
      checked_at: z.string().nullish(),
    })
    .nullish(),
})
const domainListEnvelopeSchema = z.object({
  data: z.array(domainDataSchema),
  pagination: paginationSchema.optional(),
})

const warmingDataSchema = z.object({
  id: z.string(),
  full_address: z.string(),
  warming_status: z.enum(['active', 'paused', 'connecting', 'connection_problem', 'disabled']),
  warming_health_score: z.number().nullish(),
  warming_total_sent: z.number().nullish(),
  warming_total_replies: z.number().nullish(),
  warming_last_sync: z.string().nullish(),
})
const warmingListEnvelopeSchema = z.object({
  data: z.array(warmingDataSchema),
  pagination: paginationSchema.optional(),
})
const warmingEnableEnvelopeSchema = z.object({
  data: z.object({ enabled: z.array(warmingDataSchema) }),
})

const metricDataSchema = z.object({
  date: z.string(),
  sent: z.number().nullish(),
  inbox: z.number().nullish(),
  spam: z.number().nullish(),
  replies: z.number().nullish(),
  inbox_rate: z.number().nullish(),
})
const metricsEnvelopeSchema = z.object({
  data: z.object({ metrics: z.array(metricDataSchema) }),
})

const emailDataSchema = z.object({
  id: z.string(),
  uid: z.coerce.string().nullish(),
  message_id: z.string().nullish(),
  thread_id: z.string().nullish(),
  from: z.string().nullish(),
  to: z.string().nullish(),
  subject: z.string().nullish(),
  body_preview: z.string().nullish(),
  received_at: z.string().nullish(),
  mailbox: z.string().nullish(),
})
const inboxListEnvelopeSchema = z.object({
  data: z.array(emailDataSchema),
  pagination: paginationSchema.optional(),
})

const sendEnvelopeSchema = z.object({
  data: z.object({
    success: z.boolean().optional(),
    message_id: z.string().nullish(),
  }),
})

const acknowledgementSchema = z.object({
  success: z.literal(true).optional(),
  error: z.never().optional(),
  data: z.object({ success: z.literal(true).optional(), error: z.never().optional() }).optional(),
})

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null
  const trimmed = value.trim()
  if (/^\d+$/.test(trimmed)) return Number(trimmed)
  const timestamp = Date.parse(trimmed)
  if (Number.isFinite(timestamp)) {
    const seconds = Math.ceil((timestamp - Date.now()) / 1000)
    return seconds > 0 ? seconds : 0
  }
  return null
}

/**
 * Validate an id that will be placed in a URL path segment or a JSON body.
 * Rejects empty, whitespace, slash and dotpath values so path traversal and
 * header/body smuggling are impossible.
 */
function validateId(value: string, label: string): string {
  if (typeof value !== 'string' || value === '' || /\s/.test(value)) {
    throw new WinnrError(`Invalid Winnr ${label}`, { code: 'invalid_id' })
  }
  if (value.includes('/') || value.includes('\\')) {
    throw new WinnrError(`Invalid Winnr ${label}`, { code: 'invalid_id' })
  }
  if (value === '.' || value === '..' || value.includes('..')) {
    throw new WinnrError(`Invalid Winnr ${label}`, { code: 'invalid_id' })
  }
  return value
}

function encodePathId(value: string, label: string): string {
  return encodeURIComponent(validateId(value, label))
}

function boundedNumber(value: number | undefined, min: number, max: number): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value)) return undefined
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function sanitizeText(value: string | null | undefined): string {
  if (!value) return ''
  return value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
}

function malformedError(status: number, outcomeUnknown: boolean): WinnrError {
  return new WinnrError('Winnr returned a malformed response', {
    status,
    code: 'malformed_response',
    outcomeUnknown,
  })
}

// ---------------------------------------------------------------------------
// Normalizers (wire -> domain)
// ---------------------------------------------------------------------------

function normalizeAccount(data: z.infer<typeof accountDataSchema>): WinnrAccount {
  return {
    id: data.id,
    name: data.name,
    plan: data.plan ?? null,
    permissions: data.api_token?.permissions ?? [],
    universalInboxEnabled: data.universal_inbox_enabled ?? false,
  }
}

function normalizeMailbox(data: z.infer<typeof mailboxDataSchema>): Mailbox {
  return {
    id: data.id,
    email: data.full_address,
    name: data.name ?? null,
    status: data.status,
    dailyLimit: data.daily_send_limit ?? null,
  }
}

function normalizeDomain(data: z.infer<typeof domainDataSchema>): Domain {
  return {
    id: data.id,
    name: data.name,
    status: data.status,
    dnsHealth: data.dns_health?.status ?? null,
    checkedAt: data.dns_health?.checked_at ?? null,
  }
}

function normalizeWarming(data: z.infer<typeof warmingDataSchema>): WarmingMailbox {
  return {
    id: data.id,
    email: data.full_address,
    status: data.warming_status,
    healthScore: data.warming_health_score ?? null,
    sent: data.warming_total_sent ?? null,
    replies: data.warming_total_replies ?? null,
    lastSyncedAt: data.warming_last_sync ?? null,
  }
}

function normalizeMetric(data: z.infer<typeof metricDataSchema>): WarmingMetric {
  return {
    date: data.date,
    sent: data.sent ?? null,
    inbox: data.inbox ?? null,
    spam: data.spam ?? null,
    replies: data.replies ?? null,
    inboxRate: data.inbox_rate ?? null,
  }
}

function normalizeInbox(data: z.infer<typeof emailDataSchema>): InboxMessage {
  return {
    id: data.id,
    uid: data.uid ?? '',
    messageId: data.message_id ?? '',
    threadId: data.thread_id ?? '',
    from: sanitizeText(data.from),
    to: sanitizeText(data.to),
    subject: sanitizeText(data.subject),
    preview: sanitizeText(data.body_preview),
    receivedAt: data.received_at ?? '',
    mailbox: sanitizeText(data.mailbox),
  }
}

// ---------------------------------------------------------------------------
// Client factory
// ---------------------------------------------------------------------------

export function WinnrClient(options: WinnrClientOptions): WinnrClient {
  const { token } = options

  if (typeof token !== 'string' || token.length === 0 || /\s/.test(token)) {
    // Never include the supplied value.
    throw new WinnrError('Invalid Winnr API token', { code: 'invalid_token' })
  }

  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new WinnrError('No fetch implementation available', { code: 'fetch_unavailable' })
  }

  const timeoutMs =
    typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_TIMEOUT_MS

  interface RawResponse {
    status: number
    text: string
    retryAfterSeconds: number | null
  }

  async function perform(method: HttpMethod, path: string, query: Query, body?: unknown): Promise<RawResponse> {
    const url = new URL(path, BASE_URL)
    if (url.origin !== BASE_URL) {
      throw new WinnrError('Refusing a non-Winnr request origin', { code: 'invalid_origin' })
    }
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    // The caller's cancellation is combined with the per-request timeout so
    // neither signal can be silently replaced. Body consumption stays under
    // this combined signal because the response is read after fetch resolves.
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal
    try {
      const response = await fetchImpl(url.toString(), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
        redirect: 'error',
      })
      const text = await response.text()
      return {
        status: response.status,
        text,
        retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')),
      }
    } catch (error) {
      const aborted = signal.aborted || (error instanceof Error && error.name === 'AbortError')
      throw new WinnrError(aborted ? 'Winnr request timed out' : 'Winnr request failed before a response', {
        code: aborted ? 'timeout' : 'network_error',
        outcomeUnknown: method !== 'GET',
      })
    } finally {
      clearTimeout(timer)
    }
  }

  function httpError(raw: RawResponse, method: HttpMethod): WinnrError {
    const uncertain =
      (raw.status >= 300 && raw.status < 400) ||
      raw.status >= 500 ||
      UNCERTAIN_STATUSES.has(raw.status)
    return new WinnrError(`Winnr request failed with status ${raw.status}`, {
      status: raw.status,
      // Even an identifier-shaped upstream code can contain a reflected token.
      code: `winnr_http_${raw.status}`,
      outcomeUnknown: method === 'GET' ? false : uncertain,
      retryAfterSeconds: raw.retryAfterSeconds,
    })
  }

  function decode<T>(raw: RawResponse, schema: z.ZodType<T>, outcomeUnknown: boolean): T {
    let json: unknown
    try {
      json = JSON.parse(raw.text)
    } catch {
      throw malformedError(raw.status, outcomeUnknown)
    }
    const result = schema.safeParse(json)
    if (!result.success) throw malformedError(raw.status, outcomeUnknown)
    return result.data
  }

  async function getJson<T>(path: string, query: Query, parse: (raw: RawResponse) => T): Promise<T> {
    let lastError: WinnrError | null = null
    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
      let raw: RawResponse
      try {
        raw = await perform('GET', path, query)
      } catch (error) {
        lastError = error as WinnrError
        if (attempt + 1 < MAX_READ_ATTEMPTS) {
          await sleep(RETRY_DELAY_MS)
          continue
        }
        throw lastError
      }
      if (raw.status >= 500 && attempt + 1 < MAX_READ_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS)
        continue
      }
      if (raw.status >= 200 && raw.status < 300) return parse(raw)
      throw httpError(raw, 'GET')
    }
    throw lastError ?? new WinnrError('Winnr request failed', { code: 'network_error' })
  }

  async function mutateVoid(method: HttpMethod, path: string, body?: unknown): Promise<void> {
    const raw = await perform(method, path, {}, body)
    if (raw.status < 200 || raw.status >= 300) throw httpError(raw, method)
    if (raw.text.trim() === '') return
    decode(raw, acknowledgementSchema, true)
  }

  function toCursorPage<T>(items: T[], pagination: z.infer<typeof paginationSchema> | undefined): CursorPage<T> {
    if (!pagination || (pagination.has_more === undefined && pagination.cursor === undefined)) {
      throw malformedError(200, false)
    }
    const nextCursor = pagination?.cursor ?? null
    if (pagination.has_more === true && !nextCursor) throw malformedError(200, false)
    return {
      items,
      nextCursor,
      hasMore: pagination?.has_more ?? nextCursor !== null,
    }
  }

  return {
    async getAccount(): Promise<WinnrAccount> {
      return getJson('/v1/account', {}, (raw) => {
        const parsed = decode(raw, accountEnvelopeSchema, false)
        return normalizeAccount(parsed.data)
      })
    },

    async listMailboxes(params = {}): Promise<CursorPage<Mailbox>> {
      const query: Query = { cursor: params.cursor, limit: boundedNumber(params.limit, 1, MAX_CURSOR_LIMIT) }
      return getJson('/v1/email-users', query, (raw) => {
        const parsed = decode(raw, mailboxListEnvelopeSchema, false)
        return toCursorPage(
          parsed.data.map(normalizeMailbox),
          parsed.pagination
        )
      })
    },

    async listDomains(params = {}): Promise<CursorPage<Domain>> {
      const query: Query = { cursor: params.cursor, limit: boundedNumber(params.limit, 1, MAX_CURSOR_LIMIT) }
      return getJson('/v1/domains', query, (raw) => {
        const parsed = decode(raw, domainListEnvelopeSchema, false)
        return toCursorPage(
          parsed.data.map(normalizeDomain),
          parsed.pagination
        )
      })
    },

    async listWarming(params = {}): Promise<WarmingPage> {
      const requestedPage = boundedNumber(params.page, 1, Number.MAX_SAFE_INTEGER) ?? 1
      const requestedPerPage = boundedNumber(params.perPage, 1, MAX_WARMING_PER_PAGE)
      const query: Query = { page: requestedPage, per_page: requestedPerPage }
      return getJson('/v1/warming', query, (raw) => {
        const parsed = decode(raw, warmingListEnvelopeSchema, false)
        const items = parsed.data.map(normalizeWarming)
        const page = parsed.pagination?.page ?? requestedPage
        const perPage = parsed.pagination?.per_page ?? requestedPerPage ?? 100
        const total = parsed.pagination?.total ?? null
        const hasMore =
          parsed.pagination?.has_more ??
          (total !== null ? perPage > 0 && page * perPage < total : items.length > 0 && items.length === perPage)
        return { items, page, perPage, total, hasMore }
      })
    },

    async getWarmingMetrics(mailboxId: string): Promise<WarmingMetric[]> {
      const id = encodePathId(mailboxId, 'mailbox id')
      return getJson(`/v1/warming/${id}/metrics`, {}, (raw) => {
        const parsed = decode(raw, metricsEnvelopeSchema, false)
        return parsed.data.metrics.map(normalizeMetric)
      })
    },

    async enableWarming(ids: string[], settings: WinnrSettings): Promise<WarmingMailbox[]> {
      const safeIds = requireIds(ids)
      const raw = await perform('POST', '/v1/warming/enable', {}, {
        user_ids: safeIds,
        settings: {
          emails_per_day: settings.emailsPerDay,
          response_rate: settings.responseRate,
          rampup_enabled: settings.rampupEnabled,
          rampup_speed: settings.rampupSpeed,
        },
      })
      if (raw.status < 200 || raw.status >= 300) throw httpError(raw, 'POST')
      const parsed = decode(raw, warmingEnableEnvelopeSchema, true)
      const acknowledgedIds = new Set(parsed.data.enabled.map(mailbox => mailbox.id))
      if (acknowledgedIds.size !== safeIds.length || parsed.data.enabled.length !== safeIds.length ||
          safeIds.some(id => !acknowledgedIds.has(id))) {
        throw new WinnrError('Winnr did not confirm all requested warm-up accounts', {
          status: raw.status, code: 'warming_unconfirmed', outcomeUnknown: true,
        })
      }
      return parsed.data.enabled.map(normalizeWarming)
    },

    async pauseWarming(id: string): Promise<void> {
      return mutateVoid('POST', `/v1/warming/${encodePathId(id, 'mailbox id')}/pause`)
    },

    async resumeWarming(id: string): Promise<void> {
      return mutateVoid('POST', `/v1/warming/${encodePathId(id, 'mailbox id')}/resume`)
    },

    async disableWarming(ids: string[]): Promise<void> {
      return mutateVoid('POST', '/v1/warming/disable', { user_ids: requireIds(ids) })
    },

    async listInbox(params = {}): Promise<CursorPage<InboxMessage>> {
      if (params.mailboxId !== undefined) {
        const id = encodePathId(params.mailboxId, 'mailbox id')
        const query: Query = {
          cursor: params.cursor,
          limit: boundedNumber(params.limit, 1, MAX_CURSOR_LIMIT),
        }
        return getJson(`/v1/email-users/${id}/inbox`, query, (raw) => {
          const parsed = decode(raw, inboxListEnvelopeSchema, false)
          return toCursorPage(
            parsed.data.map(normalizeInbox),
            parsed.pagination
          )
        })
      }
      const query: Query = {
        cursor: params.cursor,
        limit: boundedNumber(params.limit, 1, MAX_ACCOUNT_INBOX_LIMIT),
      }
      return getJson('/v1/inbox', query, (raw) => {
        const parsed = decode(raw, inboxListEnvelopeSchema, false)
        return toCursorPage(
          parsed.data.map(normalizeInbox),
          parsed.pagination
        )
      })
    },

    async sendMessage(input: SendMessageInput): Promise<SendResult> {
      const id = encodePathId(input.mailboxId, 'mailbox id')
      const body: Record<string, unknown> = {
        to: input.to,
        subject: input.subject,
        body: input.body,
      }
      if (input.html !== undefined) body.html = input.html
      if (input.inReplyTo !== undefined) body.in_reply_to = input.inReplyTo
      if (input.references !== undefined) body.references = input.references

      const raw = await perform('POST', `/v1/email-users/${id}/inbox/send`, {}, body)
      if (raw.status < 200 || raw.status >= 300) throw httpError(raw, 'POST')

      const parsed = decode(raw, sendEnvelopeSchema, true)
      const messageId = parsed.data.message_id
      if (parsed.data.success === true && typeof messageId === 'string' && messageId.trim() !== '') {
        return { messageId }
      }
      if (parsed.data.success === false) {
        throw new WinnrError('Winnr rejected the send', {
          status: raw.status,
          code: 'send_rejected',
          outcomeUnknown: false,
        })
      }
      throw new WinnrError('Winnr did not confirm the send', {
        status: raw.status,
        code: 'send_unconfirmed',
        outcomeUnknown: true,
      })
    },
  }
}

function requireIds(ids: string[]): string[] {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new WinnrError('Invalid Winnr mailbox id', { code: 'invalid_id' })
  }
  return ids.map((id) => validateId(id, 'mailbox id'))
}
