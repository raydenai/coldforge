/**
 * Channel-independent outreach event service (plan Wave 2).
 *
 * This module owns the parts of the event spine that must be provable without a
 * database: the canonical v1 event shape, bounded validation, deterministic
 * fingerprinting, and the typed repository contract. All storage and locking
 * behaviour lives behind `OutreachEventRepository` so the service can be
 * exercised with fakes and the production adapter stays narrow.
 *
 * Canonical v1 event:
 *   version (literal 1), organizationId, type, source, sourceEventId,
 *   occurredAt, correlationId (nullable), causationId (nullable),
 *   subject { leadId?, campaignId?, messageId?, appointmentId? },
 *   data (bounded JSON object).
 *
 * The fingerprint is a deterministic sha256 of the normalized event. It is sent
 * to SQL for observability, but SQL never trusts it alone: duplicate detection
 * compares the stored canonical fields (including `version`) and consumer set.
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'

export class OutreachEventValidationError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`Invalid outreach event input: ${issues.join('; ')}`)
    this.name = 'OutreachEventValidationError'
    this.issues = issues
  }
}

export class OutreachEventError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OutreachEventError'
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PRINTABLE_RE = /^[\x20-\x7E]+$/

/**
 * Bound on the canonical JSON bytes of `data`. SQL owns the authoritative gate
 * (`octet_length(data::text)`, i.e. PostgreSQL `jsonb` text) for this same
 * constant; TypeScript pre-checks the equivalent canonical JSON text so neither
 * layer can commit a payload the other would refuse.
 */
const MAX_DATA_BYTES = 16384
const MAX_DATA_DEPTH = 6
const MAX_DATA_KEYS = 256
const MAX_CONSUMERS = 32

/** The only canonical event version this spine accepts. */
export const OUTREACH_EVENT_VERSION = 1 as const

/** A JSON value that is guaranteed to survive PostgreSQL `jsonb` persistence. */
export type OutreachJsonValue =
  | string
  | number
  | boolean
  | null
  | OutreachJsonValue[]
  | { [key: string]: OutreachJsonValue }

export type OutreachJsonObject = { [key: string]: OutreachJsonValue }

function boundedId(max: number) {
  return z
    .string()
    .max(max)
    .regex(PRINTABLE_RE, 'must be printable ASCII without newlines')
    .refine((value) => value.trim().length > 0, 'must not be blank')
}

const uuidSchema = z.string().regex(UUID_RE, 'must be a UUID')

/**
 * Strict, timezone-explicit RFC3339 instant. Calendar rollover (`2026-02-30`)
 * and local-time shorthand (`1`) are rejected rather than being reinterpreted
 * in the worker's local timezone. The validated string is returned unchanged so
 * lease-fencing instants keep their full microsecond precision.
 */
function isExplicitInstant(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value
    )
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return false
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return false
  if (match[7] !== 'Z' && (Number(match[9]) > 23 || Number(match[10]) > 59)) return false
  return true
}

const timestampSchema = z
  .string()
  .max(64)
  .refine(isExplicitInstant, 'must be an RFC3339 instant with an explicit timezone')

const subjectSchema = z
  .strictObject({
    leadId: uuidSchema.nullish(),
    campaignId: uuidSchema.nullish(),
    messageId: uuidSchema.nullish(),
    appointmentId: uuidSchema.nullish(),
  })
  .optional()

const eventSchema = z.strictObject({
  version: z.literal(OUTREACH_EVENT_VERSION),
  organizationId: uuidSchema,
  type: boundedId(128),
  source: boundedId(128),
  sourceEventId: boundedId(256),
  occurredAt: timestampSchema,
  correlationId: boundedId(256).nullish(),
  causationId: boundedId(256).nullish(),
  subject: subjectSchema,
  data: z.unknown().optional(),
})

const consumersSchema = z
  .array(boundedId(128))
  .max(MAX_CONSUMERS)
  .refine((values) => new Set(values).size === values.length, 'consumers must be unique')

export interface OutreachEventSubject {
  leadId?: string
  campaignId?: string
  messageId?: string
  appointmentId?: string
}

export interface OutreachEventV1 {
  version: typeof OUTREACH_EVENT_VERSION
  organizationId: string
  type: string
  source: string
  sourceEventId: string
  occurredAt: string
  correlationId: string | null
  causationId: string | null
  subject: OutreachEventSubject
  data: OutreachJsonObject
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
}

/**
 * Recursively fold an untrusted value into a canonical JSON tree, rejecting
 * anything that would be silently altered or dropped on persistence
 * (`undefined`, functions, symbols, bigints, `NaN`/`Infinity`, `Date`, `Map`,
 * class instances, ...). The returned tree is a fresh plain-JSON structure.
 */
function canonicalizeJsonValue(
  value: unknown,
  depth: number,
  counter: { keys: number }
): OutreachJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new OutreachEventValidationError(['data numbers must be finite JSON numbers'])
    }
    return value
  }
  if (typeof value !== 'object') {
    throw new OutreachEventValidationError([
      'data may only contain JSON primitives, arrays and plain objects',
    ])
  }
  if (depth > MAX_DATA_DEPTH) {
    throw new OutreachEventValidationError([`data exceeds maximum depth ${MAX_DATA_DEPTH}`])
  }
  if (Array.isArray(value)) {
    // Visit every index explicitly: `.map` skips holes in sparse arrays, which
    // would silently persist as `null`. An absent slot is not a JSON value.
    const result: OutreachJsonValue[] = new Array(value.length)
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new OutreachEventValidationError(['data arrays must not contain empty slots'])
      }
      result[index] = canonicalizeJsonValue(value[index], depth + 1, counter)
    }
    return result
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new OutreachEventValidationError(['data may only contain plain JSON objects'])
  }
  const result: OutreachJsonObject = {}
  for (const key of Object.keys(value as Record<string, unknown>)) {
    counter.keys += 1
    if (counter.keys > MAX_DATA_KEYS) {
      throw new OutreachEventValidationError([`data exceeds maximum key count ${MAX_DATA_KEYS}`])
    }
    const canonical = canonicalizeJsonValue(
      (value as Record<string, unknown>)[key],
      depth + 1,
      counter
    )
    // defineProperty (not assignment) so a JSON `__proto__` key stays an own
    // data property instead of mutating the result's prototype.
    Object.defineProperty(result, key, {
      value: canonical,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return result
}

/**
 * Canonical JSON text for the byte bound, rendered the way PostgreSQL prints
 * `jsonb` (`", "` / `": "` separators, sorted keys). Key order does not change
 * the byte length; it is sorted only to keep the measurement deterministic.
 */
function canonicalJsonText(value: OutreachJsonValue): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJsonText).join(', ')}]`
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}: ${canonicalJsonText(entry)}`)
    .join(', ')}}`
}

function canonicalizeData(input: unknown): OutreachJsonObject {
  if (input === undefined) return {}
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new OutreachEventValidationError(['data must be a JSON object'])
  }
  const canonical = canonicalizeJsonValue(input, 1, { keys: 0 })
  const serialized = canonicalJsonText(canonical)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DATA_BYTES) {
    throw new OutreachEventValidationError([
      `data exceeds maximum size ${MAX_DATA_BYTES} canonical bytes`,
    ])
  }
  return canonical as OutreachJsonObject
}

/** Validate untrusted input and return the normalized canonical v1 event. */
export function normalizeOutreachEvent(input: unknown): OutreachEventV1 {
  const parsed = eventSchema.safeParse(input)
  if (!parsed.success) throw new OutreachEventValidationError(formatIssues(parsed.error))
  const value = parsed.data
  const data = canonicalizeData(value.data)

  const subject: OutreachEventSubject = {}
  if (value.subject?.leadId) subject.leadId = value.subject.leadId
  if (value.subject?.campaignId) subject.campaignId = value.subject.campaignId
  if (value.subject?.messageId) subject.messageId = value.subject.messageId
  if (value.subject?.appointmentId) subject.appointmentId = value.subject.appointmentId

  // A timezone offset can roll a syntactically valid four-digit year outside
  // the canonical UTC year range (`9999-12-31T23:59:59-01:00`). Bound the
  // normalized instant so a claimed receipt can always be re-normalized.
  const instant = new Date(value.occurredAt)
  const utcYear = instant.getUTCFullYear()
  if (!Number.isFinite(instant.getTime()) || utcYear < 1 || utcYear > 9999) {
    throw new OutreachEventValidationError([
      'occurredAt must normalize to a UTC year between 1 and 9999',
    ])
  }

  return {
    version: OUTREACH_EVENT_VERSION,
    organizationId: value.organizationId,
    type: value.type,
    source: value.source,
    sourceEventId: value.sourceEventId,
    occurredAt: instant.toISOString(),
    correlationId: value.correlationId ?? null,
    causationId: value.causationId ?? null,
    subject,
    data,
  }
}

/** Stable JSON: object keys sorted at every depth, so key order cannot change the hash. */
function stableStringify(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  )
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`
}

/** Deterministic sha256 over the normalized canonical event (hex, 64 chars). */
export function computeEventFingerprint(input: unknown): string {
  const normalized = normalizeOutreachEvent(input)
  return createHash('sha256').update(stableStringify(normalized)).digest('hex')
}

export type AppendEventOutcome = 'created' | 'duplicate' | 'conflict'

export interface AppendEventRepositoryInput {
  organizationId: string
  event: OutreachEventV1
  consumers: string[]
  fingerprint: string
}

export interface AppendEventResult {
  result: AppendEventOutcome
  eventId: string
}

export interface ClaimOutboxRepositoryInput {
  organizationId: string
  consumer: string
  leaseToken: string
  leaseSeconds: number
  limit: number
  /**
   * Optional absolute request deadline (epoch ms) used only to bound the
   * storage RPC abort signal. Never persisted and never part of the event
   * fingerprint or lease/fencing semantics.
   */
  deadlineAt?: number
}

export interface OutreachOutboxJob {
  outboxId: string
  eventId: string
  attempts: number
  leaseExpiresAt: string
  event: OutreachEventV1
}

export interface ClaimOutboxResult {
  result: 'claimed'
  jobs: OutreachOutboxJob[]
}

export interface SettleOutboxRepositoryInput {
  organizationId: string
  outboxId: string
  leaseToken: string
  leaseExpiresAt: string
  /** Optional per-call RPC abort budget; not persisted and not part of the digest. */
  deadlineAt?: number
}

export interface FailOutboxRepositoryInput extends SettleOutboxRepositoryInput {
  errorCode: string | null
  retryable: boolean
}

export interface MarkUnknownRepositoryInput extends SettleOutboxRepositoryInput {
  reason: string | null
}

export interface AckOutboxResult {
  result: 'acked' | 'stale' | 'not_found'
}

export interface FailOutboxResult {
  result: 'retryable' | 'failed' | 'stale' | 'not_found'
  attempts?: number
}

export interface MarkUnknownResult {
  result: 'unknown' | 'stale' | 'not_found'
}

export interface OutreachEventRepository {
  appendEvent(input: AppendEventRepositoryInput): Promise<AppendEventResult>
  claimOutbox(input: ClaimOutboxRepositoryInput): Promise<ClaimOutboxResult>
  ackOutbox(input: SettleOutboxRepositoryInput): Promise<AckOutboxResult>
  failOutbox(input: FailOutboxRepositoryInput): Promise<FailOutboxResult>
  markUnknown(input: MarkUnknownRepositoryInput): Promise<MarkUnknownResult>
}

export interface OutreachEventServiceDeps {
  repository: OutreachEventRepository
}

export interface AppendOutreachEventInput {
  event: unknown
  consumers: unknown
}

export interface ClaimOutreachOutboxInput {
  organizationId: unknown
  consumer: unknown
  leaseToken: unknown
  leaseSeconds: unknown
  limit: unknown
  deadlineAt?: unknown
}

export interface SettleOutreachOutboxInput {
  organizationId: unknown
  outboxId: unknown
  leaseToken: unknown
  leaseExpiresAt: unknown
  deadlineAt?: unknown
}

export interface FailOutreachOutboxInput extends SettleOutreachOutboxInput {
  errorCode?: unknown
  retryable: unknown
}

export interface MarkOutreachUnknownInput extends SettleOutreachOutboxInput {
  reason?: unknown
}

export interface OutreachEventService {
  append(input: AppendOutreachEventInput): Promise<AppendEventResult>
  claim(input: ClaimOutreachOutboxInput): Promise<ClaimOutboxResult>
  ack(input: SettleOutreachOutboxInput): Promise<AckOutboxResult>
  fail(input: FailOutreachOutboxInput): Promise<FailOutboxResult>
  markUnknown(input: MarkOutreachUnknownInput): Promise<MarkUnknownResult>
}

/** Optional absolute RPC deadline; bounded so it can never be a negative budget. */
const deadlineSchema = z.number().int().positive().optional()

const claimSchema = z.object({
  organizationId: uuidSchema,
  consumer: boundedId(128),
  leaseToken: uuidSchema,
  leaseSeconds: z.number().int().min(1).max(3600),
  limit: z.number().int().min(1).max(100),
  deadlineAt: deadlineSchema,
})

const settleSchema = z.object({
  organizationId: uuidSchema,
  outboxId: uuidSchema,
  leaseToken: uuidSchema,
  leaseExpiresAt: timestampSchema,
  deadlineAt: deadlineSchema,
})

const failSchema = settleSchema.extend({
  errorCode: z.string().max(1024).regex(PRINTABLE_RE).nullish(),
  retryable: z.boolean(),
})

const unknownSchema = settleSchema.extend({
  reason: z.string().max(1024).regex(PRINTABLE_RE).nullish(),
})

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new OutreachEventValidationError(formatIssues(parsed.error))
  return parsed.data
}

export function createOutreachEventService(deps: OutreachEventServiceDeps): OutreachEventService {
  return {
    async append(input: AppendOutreachEventInput): Promise<AppendEventResult> {
      const event = normalizeOutreachEvent(input.event)
      const consumers = parseOrThrow(consumersSchema, input.consumers)
      const fingerprint = computeEventFingerprint(event)
      return deps.repository.appendEvent({
        organizationId: event.organizationId,
        event,
        consumers,
        fingerprint,
      })
    },

    async claim(input: ClaimOutreachOutboxInput): Promise<ClaimOutboxResult> {
      const parsed = parseOrThrow(claimSchema, input)
      return deps.repository.claimOutbox(parsed)
    },

    async ack(input: SettleOutreachOutboxInput): Promise<AckOutboxResult> {
      const parsed = parseOrThrow(settleSchema, input)
      return deps.repository.ackOutbox(parsed)
    },

    async fail(input: FailOutreachOutboxInput): Promise<FailOutboxResult> {
      const parsed = parseOrThrow(failSchema, input)
      return deps.repository.failOutbox({
        organizationId: parsed.organizationId,
        outboxId: parsed.outboxId,
        leaseToken: parsed.leaseToken,
        leaseExpiresAt: parsed.leaseExpiresAt,
        errorCode: parsed.errorCode ?? null,
        retryable: parsed.retryable,
        ...(parsed.deadlineAt === undefined ? {} : { deadlineAt: parsed.deadlineAt }),
      })
    },

    async markUnknown(input: MarkOutreachUnknownInput): Promise<MarkUnknownResult> {
      const parsed = parseOrThrow(unknownSchema, input)
      return deps.repository.markUnknown({
        organizationId: parsed.organizationId,
        outboxId: parsed.outboxId,
        leaseToken: parsed.leaseToken,
        leaseExpiresAt: parsed.leaseExpiresAt,
        reason: parsed.reason ?? null,
        ...(parsed.deadlineAt === undefined ? {} : { deadlineAt: parsed.deadlineAt }),
      })
    },
  }
}
