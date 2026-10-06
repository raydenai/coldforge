/**
 * Bounded downstream outreach core (shard 033).
 *
 * Types, schemas and the provider port contracts. No storage, no network and
 * no vendor payload leaks into this module: adapters translate at the edge,
 * the domain keeps only stable identifiers and receipts.
 */
import { z } from 'zod'

export const DOWNSTREAM_PROVIDERS = ['ghl', 'closebot', 'retell'] as const
export type DownstreamProvider = (typeof DOWNSTREAM_PROVIDERS)[number]

export const DOWNSTREAM_EFFECT_KINDS = ['ghl_contact', 'ghl_opportunity', 'closebot_forward', 'ghl_note'] as const
export type DownstreamEffectKind = (typeof DOWNSTREAM_EFFECT_KINDS)[number]

/** The canonical 030 decision consumer this module owns. */
export const DECISION_CONSUMER = 'outreach.conversation.decision' as const

export const DOWNSTREAM_LEASE_SECONDS = 20
export const SETTLEMENT_RESERVE_MS = 4_000
export const DEFAULT_REQUEST_BUDGET_MS = 29_000

/** Fixed provider origins. A configured callback URL is never fetched. */
export const GHL_ORIGIN = 'https://services.leadconnectorhq.com'
export const CLOSEBOT_ORIGIN = 'https://api.closebot.com'
export const RETELL_ORIGIN = 'https://api.retellai.com'

/**
 * Official GHL Ed25519 webhook public key, published in the Webhook
 * Integration Guide (v3). It is a constant, never a user-supplied key: a
 * tenant cannot establish GHL provider identity by pasting its own PEM.
 * Source: https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide/index.html
 */
export const GHL_WEBHOOK_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=
-----END PUBLIC KEY-----`

/** Bounded webhook/raw-body limits; captured before any auth or parsing. */
export const MAX_WEBHOOK_BYTES = 256 * 1024

/** Retell list-phone-numbers pagination is bounded, never unbounded. */
export const RETELL_MAX_PAGES = 5
export const RETELL_PAGE_LIMIT = 100

export class DownstreamError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
  ) {
    super(message)
    this.name = 'DownstreamError'
  }
}

const jsonObjectSchema = z.record(z.string(), z.unknown())

export const connectionPresenceSchema = z.object({
  provider: z.enum(DOWNSTREAM_PROVIDERS),
  revision: z.number().int().positive(),
  enabled: z.boolean(),
  configured: z.boolean(),
  config: jsonObjectSchema,
  capability: jsonObjectSchema,
  lastCheckAt: z.string().nullable(),
  lastCheckOk: z.boolean().nullable(),
  lastCheckDetail: z.string().nullable(),
  verifiedAt: z.string().nullable(),
  updatedAt: z.string(),
})
export type ConnectionPresence = z.infer<typeof connectionPresenceSchema>

const crmLinkSchema = z.object({
  organization_id: z.string(),
  lead_id: z.string(),
  provider: z.string(),
  external_contact_id: z.string().nullable(),
  external_opportunity_id: z.string().nullable(),
  location_id: z.string().nullable(),
  revision: z.number(),
  synced_at: z.string().nullable(),
})
const appointmentSchema = z.object({
  id: z.string(),
  lead_id: z.string(),
  provider: z.string(),
  calendar_id: z.string(),
  location_id: z.string().nullable(),
  starts_at: z.string(),
  ends_at: z.string().nullable(),
  timezone: z.string(),
  status: z.string(),
  provider_appointment_id: z.string().nullable(),
  error_code: z.string().nullable(),
  created_at: z.string(),
})
const eligibilitySchema = z.object({
  id: z.string(),
  lead_id: z.string(),
  phone_e164: z.string(),
  timezone: z.string(),
  window_start_hour: z.number(),
  window_end_hour: z.number(),
  expires_at: z.string(),
  max_calls: z.number(),
  calls_started: z.number(),
  consent_basis: z.string(),
  evidence: z.string(),
  revoked_at: z.string().nullable(),
  revision: z.number(),
  created_at: z.string(),
})
const callbackSchema = z.object({
  id: z.string(),
  eligibility_id: z.string(),
  lead_id: z.string(),
  phone_e164: z.string(),
  status: z.string(),
  provider_call_id: z.string().nullable(),
  summary: z.unknown().nullable(),
  created_at: z.string(),
  settled_at: z.string().nullable(),
})
const qualificationSchema = z.object({
  id: z.string(),
  lead_id: z.string(),
  criteria_revision: z.number(),
  criteria: z.unknown(),
  outcome: z.string(),
  evidence: z.string(),
  attributed_source: z.string(),
  created_at: z.string(),
})
const bridgeSchema = z.object({
  id: z.string(),
  lead_id: z.string(),
  thread_id: z.string().nullable(),
  source_id: z.string(),
  direction: z.string(),
  payload_fingerprint: z.string(),
  status: z.string(),
  proposal: z.unknown().nullable(),
  review: z.unknown().nullable(),
  created_at: z.string(),
})
const effectSchema = z.object({
  id: z.string(),
  decision_id: z.string(),
  effect_kind: z.string(),
  logical_key: z.string(),
  connection_revision: z.number(),
  status: z.string(),
  error_code: z.string().nullable(),
  created_at: z.string(),
  settled_at: z.string().nullable(),
})

export const downstreamReadSchema = z.object({
  connections: z.array(connectionPresenceSchema),
  crmLinks: z.array(crmLinkSchema),
  appointments: z.array(appointmentSchema),
  eligibility: z.array(eligibilitySchema),
  callbacks: z.array(callbackSchema),
  qualifications: z.array(qualificationSchema),
  bridge: z.array(bridgeSchema),
  effects: z.array(effectSchema),
  masterStop: z.boolean(),
  generatedAt: z.string(),
})
export type DownstreamRead = z.infer<typeof downstreamReadSchema>

// ---------------------------------------------------------------------------
// Provider ports. Each adapter is replaceable and exposes an honest capability
// descriptor; an unsupported operation is reported, never mocked.
// ---------------------------------------------------------------------------
export interface ProviderCapabilities {
  provider: DownstreamProvider
  readOnlyCheck: 'supported' | 'unsupported'
  operations: string[]
}

export interface GhlContactInput {
  locationId: string
  email: string
  firstName?: string
  lastName?: string
  phone?: string
  source: string
}
export interface GhlContactResult {
  contactId: string
  created: boolean
}
export interface GhlOpportunityInput {
  locationId: string
  pipelineId: string
  contactId: string
  name: string
  status: 'open' | 'won' | 'lost' | 'abandoned'
  monetaryValue?: number
}
export interface GhlOpportunityResult {
  opportunityId: string
}
export interface GhlSlot {
  startAt: string
  /** Only set when the verified calendar duration is known; never synthesized. */
  endAt: string | null
}
export interface GhlCalendar {
  id: string
  name: string
  /** Verified from the provider calendar; null when the provider omitted it. */
  slotDurationMinutes: number | null
  durationOptions: number[]
}
export interface GhlAppointmentInput {
  locationId: string
  calendarId: string
  contactId: string
  startAt: string
  /** Omitted entirely when the verified calendar duration is unknown. */
  endAt?: string
  timezone: string
}
export interface GhlAppointmentResult {
  appointmentId: string
  receipt: Record<string, unknown>
}
export interface GhlRescheduleInput {
  locationId: string
  appointmentId: string
  startAt: string
  endAt?: string
  timezone: string
}

export interface GhlPort {
  capabilities: ProviderCapabilities
  check(token: string, locationId: string, signal: AbortSignal): Promise<Record<string, unknown>>
  upsertContact(token: string, input: GhlContactInput, signal: AbortSignal): Promise<GhlContactResult>
  upsertOpportunity(token: string, input: GhlOpportunityInput, signal: AbortSignal): Promise<GhlOpportunityResult>
  listCalendars(token: string, locationId: string, signal: AbortSignal): Promise<GhlCalendar[]>
  getCalendar(token: string, calendarId: string, signal: AbortSignal): Promise<GhlCalendar>
  freeSlots(token: string, input: { calendarId: string; startAt: string; endAt: string; timezone: string }, signal: AbortSignal): Promise<GhlSlot[]>
  createAppointment(token: string, input: GhlAppointmentInput, signal: AbortSignal): Promise<GhlAppointmentResult>
  rescheduleAppointment(token: string, input: GhlRescheduleInput, signal: AbortSignal): Promise<{ appointmentId: string; receipt: Record<string, unknown> }>
  cancelAppointment(token: string, appointmentId: string, signal: AbortSignal): Promise<{ cancelled: boolean; receipt: Record<string, unknown> }>
}

export interface CloseBotPort {
  capabilities: ProviderCapabilities
  check(apiKey: string, signal: AbortSignal): Promise<Record<string, unknown>>
  /** Forwards one canonical inbound decision/body into the configured source. */
  sendEvent(apiKey: string, sourceId: string, event: Record<string, unknown>, signal: AbortSignal): Promise<{ accepted: boolean; receipt: Record<string, unknown> }>
}

export interface RetellPhoneNumber {
  phoneNumber: string
  phoneNumberType: string | null
  inboundAgentIds: string[]
  outboundAgentIds: string[]
  nickname: string | null
}
export interface RetellPort {
  capabilities: ProviderCapabilities
  /** Documented read-only probe: GET /v2/list-phone-numbers with bounded pagination. */
  listPhoneNumbers(apiKey: string, signal: AbortSignal): Promise<{ numbers: RetellPhoneNumber[]; hasMore: boolean; pages: number }>
  /** Documented read-only single probe: GET /v2/get-phone-number?phone_number=... */
  getPhoneNumber(apiKey: string, phoneNumber: string, signal: AbortSignal): Promise<RetellPhoneNumber | null>
  createPhoneCall(
    apiKey: string,
    input: { fromNumber: string; toNumber: string; idempotencyKey: string; metadata: Record<string, unknown> },
    signal: AbortSignal,
  ): Promise<{ callId: string; receipt: Record<string, unknown> }>
}

export interface DownstreamProviderPorts {
  ghl: GhlPort
  closebot: CloseBotPort
  retell: RetellPort
}

// ---------------------------------------------------------------------------
// Inputs accepted by the service from the browser (already authenticated).
// ---------------------------------------------------------------------------
export const saveConnectionInputSchema = z
  .object({
    provider: z.enum(DOWNSTREAM_PROVIDERS),
    expectedRevision: z.number().int().nonnegative(),
    credential: z.union([z.record(z.string(), z.unknown()), z.string().min(1).max(20000)]).optional(),
    config: z.record(z.string(), z.unknown()),
  })
  .strict()
export type SaveConnectionInput = z.infer<typeof saveConnectionInputSchema>

export const setEnabledInputSchema = z
  .object({ provider: z.enum(DOWNSTREAM_PROVIDERS), expectedRevision: z.number().int().positive(), enabled: z.boolean() })
  .strict()
export type SetEnabledInput = z.infer<typeof setEnabledInputSchema>

export const checkConnectionInputSchema = z
  .object({ provider: z.enum(DOWNSTREAM_PROVIDERS), expectedRevision: z.number().int().positive() })
  .strict()
export type CheckConnectionInput = z.infer<typeof checkConnectionInputSchema>

export const recordEligibilityInputSchema = z
  .object({
    leadId: z.string().uuid(),
    phoneE164: z.string().regex(/^\+[1-9][0-9]{7,14}$/),
    timezone: z.string().min(1).max(80),
    windowStartHour: z.number().int().min(0).max(23),
    windowEndHour: z.number().int().min(1).max(24),
    expiresAt: z.iso.datetime({ offset: true }),
    maxCalls: z.number().int().min(1).max(10),
    consentBasis: z.string().min(1).max(500),
    evidence: z.string().min(1).max(2000),
  })
  .strict()
  .refine((value) => value.windowEndHour > value.windowStartHour, { message: 'window must be positive' })
export type RecordEligibilityInput = z.infer<typeof recordEligibilityInputSchema>

export const revokeEligibilityInputSchema = z
  .object({ eligibilityId: z.string().uuid(), expectedRevision: z.number().int().positive() })
  .strict()

export const qualifyInputSchema = z
  .object({
    leadId: z.string().uuid(),
    campaignId: z.string().uuid().nullable().optional(),
    threadId: z.string().uuid().nullable().optional(),
    criteriaRevision: z.number().int().positive(),
    criteria: z.record(z.string(), z.unknown()),
    outcome: z.enum(['qualified', 'disqualified', 'unknown']),
    evidence: z.string().min(1).max(4000),
    attributedSource: z.string().min(1).max(80),
    sourceDecisionId: z.string().uuid().nullable().optional(),
  })
  .strict()
export type QualifyInput = z.infer<typeof qualifyInputSchema>

export const tickInputSchema = z.object({}).strict()

/** Operator booking/journey inputs. Provider IDs from the browser are re-bound
 * server-side to the current connection, calendar and lead. */
const ianaTimezone = z.string().min(1).max(80)

export const listSlotsInputSchema = z
  .object({
    calendarId: z.string().min(1).max(200),
    startAt: z.iso.datetime({ offset: true }),
    endAt: z.iso.datetime({ offset: true }),
    timezone: ianaTimezone,
  })
  .strict()
export type ListSlotsInput = z.infer<typeof listSlotsInputSchema>

export const requestAppointmentInputSchema = z
  .object({
    leadId: z.string().uuid(),
    threadId: z.string().uuid().nullable().optional(),
    campaignId: z.string().uuid().nullable().optional(),
    calendarId: z.string().min(1).max(200),
    startAt: z.iso.datetime({ offset: true }),
    timezone: ianaTimezone,
  })
  .strict()
export type RequestAppointmentInput = z.infer<typeof requestAppointmentInputSchema>

export const rescheduleAppointmentInputSchema = z
  .object({
    appointmentId: z.string().uuid(),
    startAt: z.iso.datetime({ offset: true }),
    timezone: ianaTimezone,
  })
  .strict()
export type RescheduleAppointmentInput = z.infer<typeof rescheduleAppointmentInputSchema>

export const cancelAppointmentInputSchema = z.object({ appointmentId: z.string().uuid() }).strict()

export const reviewBridgeInputSchema = z
  .object({
    bridgeId: z.string().uuid(),
    decision: z.enum(['taken_over', 'dismissed']),
    note: z.string().max(1000).optional(),
  })
  .strict()
export type ReviewBridgeInput = z.infer<typeof reviewBridgeInputSchema>

export const bookingResultSchema = z.object({
  allowed: z.boolean(),
  reason: z.string().optional(),
  appointmentId: z.string().optional(),
  status: z.string().optional(),
  providerAppointmentId: z.string().nullable().optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().nullable().optional(),
  receipt: z.record(z.string(), z.unknown()).optional(),
  connectionRevision: z.number().optional(),
  credentialCiphertext: z.string().nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  crmContactId: z.string().optional(),
})
export type BookingResult = z.infer<typeof bookingResultSchema>

export const connectionCheckResultSchema = z.object({
  ok: z.boolean(),
  detail: z.string(),
  capability: z.record(z.string(), z.unknown()),
})

export const effectReserveResultSchema = z.object({
  allowed: z.boolean(),
  reason: z.string().optional(),
  effectId: z.string().optional(),
  status: z.string().optional(),
  provider: z.enum(DOWNSTREAM_PROVIDERS).optional(),
  credentialCiphertext: z.string().nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  connectionRevision: z.number().optional(),
})
export type EffectReserveResult = z.infer<typeof effectReserveResultSchema>

export const nextOrgSchema = z.object({ organizationId: z.string().uuid(), actorId: z.string().uuid() }).nullable()

export const nextEffectSchema = z.object({
  effectId: z.string().uuid().nullable(),
  dispatchToken: z.string().uuid().nullable().optional(),
  effectKind: z.string().optional(),
  decisionId: z.string().optional(),
  logicalKey: z.string().optional(),
  connectionRevision: z.number().optional(),
  payloadFingerprint: z.string().optional(),
})

export const connectionSecretSchema = z.object({
  configured: z.boolean(),
  enabled: z.boolean().optional(),
  revision: z.number().optional(),
  credentialCiphertext: z.string().nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  capability: z.record(z.string(), z.unknown()).optional(),
})
export type ConnectionSecret = z.infer<typeof connectionSecretSchema>

export const effectContextSchema = z.object({
  found: z.boolean(),
  effect: effectSchema.optional(),
  connectionConfigured: z.boolean().optional(),
  connectionEnabled: z.boolean().optional(),
  connectionRevision: z.number().optional(),
  connectionStale: z.boolean().optional(),
  masterStop: z.boolean().optional(),
  credentialCiphertext: z.string().nullable().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  decision: z
    .object({
      decisionId: z.string(),
      threadId: z.string().nullable(),
      campaignId: z.string().nullable(),
      sourceReplyId: z.string(),
      approved: z.boolean(),
      policyRevision: z.number().optional(),
      classification: z.unknown(),
    })
    .nullable()
    .optional(),
  lead: z
    .object({
      leadId: z.string().nullable(),
      email: z.string().nullable(),
      phone: z.string().nullable(),
      firstName: z.string().nullable(),
      lastName: z.string().nullable(),
    })
    .nullable()
    .optional(),
  crmContactId: z.string().nullable().optional(),
  replyBody: z.string().nullable().optional(),
  bodyReady: z.boolean().optional(),
})
export type EffectContext = z.infer<typeof effectContextSchema>

export interface DownstreamTickResult {
  result: 'idle' | 'effect_settled' | 'reserved' | 'held' | 'blocked' | 'error'
  organizationId?: string
  effectId?: string
  effectKind?: string
  reserved?: number
  reason?: string
}
