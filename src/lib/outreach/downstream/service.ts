/**
 * Owner/admin downstream configuration and journey service.
 *
 * The browser can only reach presence-only metadata. Credentials (including the
 * CloseBot inbound callback token) are encrypted at rest with the existing
 * AES-256-GCM helper before they are handed to the database, and a saved
 * configuration is never reported as a verified connection: only an explicit,
 * server-run read-only capability check sets `verifiedAt`.
 */
import { createHash } from 'node:crypto'
import { decrypt, encrypt } from '@/lib/encryption'
import { WinnrApiError, type WinnrAuthContext } from '@/lib/winnr/server'
import {
  connectionCheckResultSchema,
  DownstreamError,
  type BookingResult,
  type CheckConnectionInput,
  type DownstreamProvider,
  type DownstreamProviderPorts,
  type DownstreamRead,
  type GhlCalendar,
  type GhlSlot,
  type ListSlotsInput,
  type QualifyInput,
  type RecordEligibilityInput,
  type RequestAppointmentInput,
  type RescheduleAppointmentInput,
  type ReviewBridgeInput,
  type SaveConnectionInput,
  type SetEnabledInput,
} from './core'
import { createDownstreamRepository, type DownstreamRepository } from './database'
import { createDownstreamPorts } from './runtime'

function providerSignal(deadlineAt?: number): AbortSignal {
  const remaining = deadlineAt === undefined ? 10_000 : deadlineAt - Date.now()
  if (remaining <= 0) throw new WinnrApiError(503, 'service_unavailable', 'The request deadline expired before the provider operation')
  return AbortSignal.timeout(Math.min(10_000, remaining))
}

export async function authorizeDownstreamWrite(repository: DownstreamRepository, organizationId: string, binding: Record<string, unknown>, payload: Record<string, unknown>, deadlineAt?: number): Promise<Record<string, unknown> | null> {
  providerSignal(deadlineAt)
  const payloadText = JSON.stringify(payload)
  const fingerprint = createHash('sha256').update(payloadText).digest('hex')
  const prepared = await repository.effect(organizationId, 'beginWrite', { ...binding, payloadText, fingerprint }, deadlineAt)
  if (prepared.allowed !== true) return null
  providerSignal(deadlineAt)
  const grant = { writeId: prepared.writeId, writeToken: prepared.writeToken, fingerprint }
  const authorized = await repository.effect(organizationId, 'authorizeWrite', grant, deadlineAt)
  return authorized.allowed === true ? grant : null
}

const SECRET_CONFIG_KEYS = ['inboundToken', 'apiKey', 'token'] as const

export function requireDownstreamManager(actor: WinnrAuthContext): void {
  if (!['owner', 'admin'].includes(actor.role)) {
    throw new WinnrApiError(403, 'forbidden', 'Only owners and admins can manage downstream integrations')
  }
}

export interface DownstreamServiceDeps {
  repository: DownstreamRepository
  ports: DownstreamProviderPorts
}

export function createDownstreamServiceDeps(): DownstreamServiceDeps {
  return { repository: createDownstreamRepository(), ports: createDownstreamPorts() }
}

export async function readDownstream(
  actor: WinnrAuthContext,
  deps: DownstreamServiceDeps = createDownstreamServiceDeps(),
  deadlineAt?: number,
): Promise<DownstreamRead> {
  requireDownstreamManager(actor)
  return deadlineAt === undefined ? deps.repository.read(actor) : deps.repository.read(actor, deadlineAt)
}

// ---------------------------------------------------------------------------
// Credential material. Secrets are never stored in plaintext config, a blank
// secret means "keep the stored one", and a successful save never echoes a
// secret back to the browser.
// ---------------------------------------------------------------------------
function parseSecretBlob(raw: string): Record<string, string> {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {}
      for (const [key, value] of Object.entries(parsed)) if (typeof value === 'string' && value.length > 0) out[key] = value
      return out
    }
    if (typeof parsed === 'string' && parsed.length > 0) return { apiKey: parsed }
  } catch {
    // plain string credential
  }
  return raw.length > 0 ? { apiKey: raw } : {}
}

function secretFromCredential(credential: unknown): Record<string, string> {
  if (credential === undefined || credential === null) return {}
  if (typeof credential === 'string') return credential.length > 0 ? { apiKey: credential } : {}
  if (typeof credential !== 'object' || Array.isArray(credential)) return {}
  const record = credential as Record<string, unknown>
  const out: Record<string, string> = {}
  const apiKey = record.token ?? record.apiKey ?? record.accessToken ?? record.api_key
  if (typeof apiKey === 'string' && apiKey.length > 0) out.apiKey = apiKey
  if (typeof record.inboundToken === 'string' && record.inboundToken.length > 0) out.inboundToken = record.inboundToken
  return out
}

/** Nonsecret config: secret keys removed and blank strings treated as "keep". */
function nonSecretConfig(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if ((SECRET_CONFIG_KEYS as readonly string[]).includes(key)) continue
    if (value === undefined || value === null) continue
    if (typeof value === 'string' && value.trim() === '') continue
    out[key] = value
  }
  return out
}

function redactedConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if ((SECRET_CONFIG_KEYS as readonly string[]).includes(key)) continue
    out[key] = value
  }
  return out
}

function safeDecrypt(ciphertext: string): string | null {
  try {
    return decrypt(ciphertext)
  } catch {
    return null
  }
}

function extractApiKey(blob: Record<string, string>, raw: string): string {
  if (blob.apiKey) return blob.apiKey
  const match = /"(?:token|apiKey|accessToken|api_key)"\s*:\s*"([^"]+)"/.exec(raw)
  return match?.[1] ?? raw
}

export async function saveConnection(
  actor: WinnrAuthContext,
  input: SaveConnectionInput,
  deps: DownstreamServiceDeps = createDownstreamServiceDeps(),
  deadlineAt?: number,
): Promise<Record<string, unknown>> {
  requireDownstreamManager(actor)
  const existing = await deps.repository.connectionSecret(actor.organizationId, input.provider, deadlineAt)
  const existingRaw = existing.credentialCiphertext ? safeDecrypt(existing.credentialCiphertext) : ''
  const existingBlob = existingRaw ? parseSecretBlob(existingRaw) : {}

  const incoming = secretFromCredential(input.credential)
  const configInbound = typeof input.config.inboundToken === 'string' ? input.config.inboundToken.trim() : ''
  if (configInbound) incoming.inboundToken = configInbound
  const mergedSecret = { ...existingBlob, ...incoming }

  // Preserve every stored nonsecret field; a blank field keeps the stored value.
  const mergedConfig = { ...redactedConfig(existing.config ?? {}), ...nonSecretConfig(input.config) }

  const payload: Record<string, unknown> = {
    provider: input.provider,
    expectedRevision: input.expectedRevision,
    config: mergedConfig,
  }
  // Blank secret keeps the stored credential; only a real change re-encrypts.
  if (Object.keys(incoming).length > 0) payload.ciphertext = encrypt(JSON.stringify(mergedSecret))
  return deps.repository.mutate(actor, 'saveConnection', payload, deadlineAt)
}

export async function setConnectionEnabled(
  actor: WinnrAuthContext,
  input: SetEnabledInput,
  deps: DownstreamServiceDeps = createDownstreamServiceDeps(),
  deadlineAt?: number,
): Promise<Record<string, unknown>> {
  requireDownstreamManager(actor)
  return deps.repository.mutate(
    actor,
    'setEnabled',
    { provider: input.provider, expectedRevision: input.expectedRevision, enabled: input.enabled },
    deadlineAt,
  )
}

export function connectionCheckResult(ports: DownstreamProviderPorts, provider: DownstreamProvider) {
  return ports[provider].capabilities
}

/** Read-only capability probe. It never makes a paid/effectful provider call. */
export async function checkConnection(
  actor: WinnrAuthContext,
  input: CheckConnectionInput,
  deps: DownstreamServiceDeps = createDownstreamServiceDeps(),
  deadlineAt?: number,
): Promise<Record<string, unknown>> {
  requireDownstreamManager(actor)
  const capabilities = deps.ports[input.provider].capabilities
  const secret = await deps.repository.connectionSecret(actor.organizationId, input.provider, deadlineAt)
  if (!secret.configured || !secret.credentialCiphertext) {
    const result = connectionCheckResultSchema.parse({
      ok: false,
      detail: 'credential_not_configured',
      capability: { ...capabilities, readOnlyCheck: 'unsupported' },
    })
    return deps.repository.mutate(actor, 'recordCheck', { provider: input.provider, expectedRevision: input.expectedRevision, ...result }, deadlineAt)
  }
  if (capabilities.readOnlyCheck === 'unsupported') {
    const result = connectionCheckResultSchema.parse({
      ok: false,
      detail: 'read_only_check_unsupported_by_provider',
      capability: { provider: input.provider, readOnlyCheck: 'unsupported', operations: capabilities.operations },
    })
    return deps.repository.mutate(actor, 'recordCheck', { provider: input.provider, expectedRevision: input.expectedRevision, ...result }, deadlineAt)
  }
  const decrypted = safeDecrypt(secret.credentialCiphertext)
  if (decrypted === null) {
    const result = connectionCheckResultSchema.parse({ ok: false, detail: 'credential_unreadable', capability: { ...capabilities } })
    return deps.repository.mutate(actor, 'recordCheck', { provider: input.provider, expectedRevision: input.expectedRevision, ...result }, deadlineAt)
  }
  const raw = extractApiKey(parseSecretBlob(decrypted), decrypted)
  const config = secret.config ?? {}
  const signal = providerSignal(deadlineAt)
  let ok = false
  let detail = 'check_failed'
  let capability: Record<string, unknown> = { ...capabilities }
  try {
    if (input.provider === 'ghl') {
      const locationId = typeof config.locationId === 'string' ? config.locationId : null
      if (!locationId) {
        detail = 'config_incomplete_location_id'
      } else {
        capability = { ...capabilities, probe: await deps.ports.ghl.check(raw, locationId, signal) }
        ok = true
        detail = 'connection_ok'
      }
    } else if (input.provider === 'closebot') {
      capability = { ...capabilities, probe: await deps.ports.closebot.check(raw, signal) }
      ok = true
      detail = 'connection_ok'
    } else {
      // Retell: documented read-only probe verifies the configured fromNumber
      // and its bound outbound agent without making any call.
      const fromNumber = typeof config.fromNumber === 'string' ? config.fromNumber : ''
      if (!fromNumber) {
        detail = 'config_incomplete_from_number'
      } else {
        const listing = await deps.ports.retell.listPhoneNumbers(raw, signal)
        const match = listing.numbers.find((number) => number.phoneNumber === fromNumber)
        capability = {
          ...capabilities,
          probe: {
            pages: listing.pages,
            hasMore: listing.hasMore,
            total: listing.numbers.length,
            fromNumberConfigured: Boolean(match),
            outboundAgentBound: match ? match.outboundAgentIds.length > 0 : false,
          },
        }
        ok = Boolean(match && match.outboundAgentIds.length > 0)
        detail = !match ? 'from_number_not_found' : match.outboundAgentIds.length ? 'connection_ok' : 'outbound_agent_not_bound'
      }
    }
  } catch (error) {
    detail = error instanceof DownstreamError ? error.code : 'check_failed'
  }
  const result = connectionCheckResultSchema.parse({ ok, detail, capability })
  return deps.repository.mutate(actor, 'recordCheck', { provider: input.provider, expectedRevision: input.expectedRevision, ...result }, deadlineAt)
}

export async function recordEligibility(
  actor: WinnrAuthContext,
  input: RecordEligibilityInput,
  deps: DownstreamServiceDeps = createDownstreamServiceDeps(),
  deadlineAt?: number,
): Promise<Record<string, unknown>> {
  requireDownstreamManager(actor)
  return deps.repository.mutate(actor, 'recordEligibility', { ...input }, deadlineAt)
}

export async function revokeEligibility(
  actor: WinnrAuthContext,
  input: { eligibilityId: string; expectedRevision: number },
  deps: DownstreamServiceDeps = createDownstreamServiceDeps(),
  deadlineAt?: number,
): Promise<Record<string, unknown>> {
  requireDownstreamManager(actor)
  return deps.repository.mutate(actor, 'revokeEligibility', { ...input }, deadlineAt)
}

export async function recordQualification(
  actor: WinnrAuthContext,
  input: QualifyInput,
  deps: DownstreamServiceDeps = createDownstreamServiceDeps(),
  deadlineAt?: number,
): Promise<Record<string, unknown>> {
  requireDownstreamManager(actor)
  return deps.repository.mutate(
    actor,
    'qualify',
    {
      leadId: input.leadId,
      campaignId: input.campaignId ?? null,
      threadId: input.threadId ?? null,
      criteriaRevision: input.criteriaRevision,
      criteria: input.criteria,
      outcome: input.outcome,
      evidence: input.evidence,
      attributedSource: input.attributedSource,
      sourceDecisionId: input.sourceDecisionId ?? null,
    },
    deadlineAt,
  )
}

export async function reviewBridge(
  actor: WinnrAuthContext,
  input: ReviewBridgeInput,
  deps: DownstreamServiceDeps = createDownstreamServiceDeps(),
  deadlineAt?: number,
): Promise<Record<string, unknown>> {
  requireDownstreamManager(actor)
  return deps.repository.mutate(
    actor,
    'reviewBridge',
    { bridgeId: input.bridgeId, decision: input.decision, ...(input.note ? { note: input.note } : {}) },
    deadlineAt,
  )
}

// ---------------------------------------------------------------------------
// Owner-initiated booking journey. The provider IDs and the slot are re-checked
// against the live provider; the browser cannot select an arbitrary calendar,
// contact or slot.
// ---------------------------------------------------------------------------
interface GhlConnection {
  raw: string
  locationId: string
  config: Record<string, unknown>
  revision: number
}

async function loadGhlConnection(
  actor: WinnrAuthContext,
  deps: DownstreamServiceDeps,
  deadlineAt?: number,
): Promise<GhlConnection> {
  const secret = await deps.repository.connectionSecret(actor.organizationId, 'ghl', deadlineAt)
  if (!secret.configured || !secret.enabled || secret.revision === undefined || !secret.credentialCiphertext) {
    throw new WinnrApiError(409, 'conflict', 'GoHighLevel must be configured and enabled before booking')
  }
  const decrypted = safeDecrypt(secret.credentialCiphertext)
  if (decrypted === null) throw new WinnrApiError(503, 'service_unavailable', 'The stored GoHighLevel credential could not be read')
  const config = secret.config ?? {}
  const locationId = typeof config.locationId === 'string' ? config.locationId : ''
  if (!locationId) throw new WinnrApiError(409, 'conflict', 'GoHighLevel location is not configured')
  return { raw: extractApiKey(parseSecretBlob(decrypted), decrypted), locationId, config, revision: secret.revision }
}

function bookingWindow(startsAt: string): { startAt: string; endAt: string } {
  const start = Date.parse(startsAt)
  if (!Number.isFinite(start)) throw new WinnrApiError(400, 'bad_request', 'Invalid start time')
  return { startAt: new Date(start).toISOString(), endAt: new Date(start + 24 * 60 * 60 * 1000).toISOString() }
}

function endFromDuration(startsAt: string, calendar: GhlCalendar): string | undefined {
  if (calendar.slotDurationMinutes === null) return undefined
  const start = Date.parse(startsAt)
  if (!Number.isFinite(start)) return undefined
  return new Date(start + calendar.slotDurationMinutes * 60 * 1000).toISOString()
}

export interface CalendarListResult {
  calendars: GhlCalendar[]
}

export async function listCalendars(
  actor: WinnrAuthContext,
  deps: DownstreamServiceDeps = createDownstreamServiceDeps(),
  deadlineAt?: number,
): Promise<CalendarListResult> {
  requireDownstreamManager(actor)
  const ghl = await loadGhlConnection(actor, deps, deadlineAt)
  const signal = providerSignal(deadlineAt)
  return { calendars: await deps.ports.ghl.listCalendars(ghl.raw, ghl.locationId, signal) }
}

export interface SlotListResult {
  calendar: GhlCalendar
  slots: GhlSlot[]
}

export async function listSlots(
  actor: WinnrAuthContext,
  input: ListSlotsInput,
  deps: DownstreamServiceDeps = createDownstreamServiceDeps(),
  deadlineAt?: number,
): Promise<SlotListResult> {
  requireDownstreamManager(actor)
  const ghl = await loadGhlConnection(actor, deps, deadlineAt)
  const signal = providerSignal(deadlineAt)
  // The calendar must belong to the connected location.
  const calendars = await deps.ports.ghl.listCalendars(ghl.raw, ghl.locationId, signal)
  const calendar = calendars.find((entry) => entry.id === input.calendarId)
  if (!calendar) throw new WinnrApiError(404, 'bad_request', 'Calendar not found for the connected GoHighLevel location')
  const verified = await deps.ports.ghl.getCalendar(ghl.raw, calendar.id, signal)
  const slots = await deps.ports.ghl.freeSlots(ghl.raw, { calendarId: calendar.id, startAt: input.startAt, endAt: input.endAt, timezone: input.timezone }, signal)
  return { calendar: verified.slotDurationMinutes === null ? calendar : verified, slots }
}

/** Durable reservation -> one provider write -> truthful receipt. */
export async function requestAppointment(
  actor: WinnrAuthContext,
  input: RequestAppointmentInput,
  deps: DownstreamServiceDeps = createDownstreamServiceDeps(),
  deadlineAt?: number,
): Promise<BookingResult> {
  requireDownstreamManager(actor)
  const ghl = await loadGhlConnection(actor, deps, deadlineAt)
  const signal = providerSignal(deadlineAt)
  const calendars = await deps.ports.ghl.listCalendars(ghl.raw, ghl.locationId, signal)
  const calendar = calendars.find((entry) => entry.id === input.calendarId)
  if (!calendar) return { allowed: false, reason: 'calendar_not_found' }
  const verified = await deps.ports.ghl.getCalendar(ghl.raw, calendar.id, signal)
  const window = bookingWindow(input.startAt)
  const normalizedStart = window.startAt
  const slots = await deps.ports.ghl.freeSlots(ghl.raw, { calendarId: calendar.id, startAt: window.startAt, endAt: window.endAt, timezone: input.timezone }, signal)
  // Re-check the current free slot: a slot the provider no longer offers is
  // never booked.
  if (!slots.some((slot) => slot.startAt === normalizedStart)) return { allowed: false, reason: 'slot_unavailable' }
  const computedEnd = endFromDuration(normalizedStart, verified)

  const logicalKey = `appointment:${input.leadId}:${calendar.id}:${normalizedStart}`
  const reserved = await deps.repository.reserveAppointment(
    actor.organizationId,
    {
      leadId: input.leadId,
      campaignId: input.campaignId ?? null,
      threadId: input.threadId ?? null,
      calendarId: calendar.id,
      locationId: ghl.locationId,
      startsAt: normalizedStart,
      endsAt: computedEnd ?? null,
      timezone: input.timezone,
      logicalKey,
      connectionRevision: ghl.revision,
    },
    deadlineAt,
  )
  if (reserved.allowed !== true || !reserved.appointmentId) {
    return { allowed: false, ...(reserved.reason ? { reason: reserved.reason } : {}), ...(reserved.appointmentId ? { appointmentId: reserved.appointmentId } : {}), ...(reserved.status ? { status: reserved.status } : {}) }
  }
  if (!reserved.crmContactId) return { allowed: false, reason: 'contact_not_synced', appointmentId: reserved.appointmentId }
  const payload = { locationId: ghl.locationId, calendarId: calendar.id, contactId: reserved.crmContactId, startAt: normalizedStart, ...(computedEnd ? { endAt: computedEnd } : {}), timezone: input.timezone }
  const grant = await authorizeDownstreamWrite(deps.repository, actor.organizationId, { kind: 'appointment_create', subjectId: reserved.appointmentId, actorId: actor.userId, connectionRevision: ghl.revision }, payload, deadlineAt)
  if (!grant) return { allowed: false, reason: 'authorization_changed', appointmentId: reserved.appointmentId }
  try {
    const created = await deps.ports.ghl.createAppointment(ghl.raw, payload, signal)
    const providerEnd = typeof created.receipt.endTime === 'string' ? created.receipt.endTime : computedEnd ?? null
    await deps.repository.settleAppointment(
      actor.organizationId,
      { ...grant, appointmentId: reserved.appointmentId, status: 'scheduled', providerAppointmentId: created.appointmentId, startsAt: normalizedStart, endsAt: providerEnd, receipt: created.receipt },
      deadlineAt,
    )
    return {
      allowed: true,
      appointmentId: reserved.appointmentId,
      status: 'scheduled',
      providerAppointmentId: created.appointmentId,
      startsAt: normalizedStart,
      endsAt: providerEnd,
      receipt: created.receipt,
    }
  } catch (error) {
    // The provider may have accepted the write. Hold as unknown, never retry.
    const code = error instanceof DownstreamError ? error.code : 'unexpected'
    const status = 'unknown' as const
    try {
      await deps.repository.settleAppointment(actor.organizationId, { ...grant, appointmentId: reserved.appointmentId, status, errorCode: code }, deadlineAt)
    } catch {
      // keep the reservation held for operator reconciliation
    }
    return { allowed: false, reason: code, appointmentId: reserved.appointmentId, status }
  }
}

export async function rescheduleAppointment(
  actor: WinnrAuthContext,
  input: RescheduleAppointmentInput,
  deps: DownstreamServiceDeps = createDownstreamServiceDeps(),
  deadlineAt?: number,
): Promise<BookingResult> {
  requireDownstreamManager(actor)
  const read = await deps.repository.read(actor, deadlineAt)
  const appointment = read.appointments.find((entry) => entry.id === input.appointmentId)
  if (!appointment) return { allowed: false, reason: 'appointment_not_found' }
  if (!appointment.provider_appointment_id) return { allowed: false, reason: 'appointment_not_confirmed' }
  if (!['scheduled', 'rescheduled'].includes(appointment.status)) return { allowed: false, reason: 'appointment_not_active' }
  const ghl = await loadGhlConnection(actor, deps, deadlineAt)
  const signal = providerSignal(deadlineAt)
  const calendars = await deps.ports.ghl.listCalendars(ghl.raw, ghl.locationId, signal)
  const calendar = calendars.find((entry) => entry.id === appointment.calendar_id)
  if (!calendar) return { allowed: false, reason: 'calendar_not_found' }
  const verified = await deps.ports.ghl.getCalendar(ghl.raw, calendar.id, signal)
  const window = bookingWindow(input.startAt)
  const slots = await deps.ports.ghl.freeSlots(ghl.raw, { calendarId: calendar.id, startAt: window.startAt, endAt: window.endAt, timezone: input.timezone }, signal)
  if (!slots.some((slot) => slot.startAt === window.startAt)) return { allowed: false, reason: 'slot_unavailable' }
  const computedEnd = endFromDuration(window.startAt, verified)
  const payload = { locationId: ghl.locationId, appointmentId: appointment.provider_appointment_id, startAt: window.startAt, ...(computedEnd ? { endAt: computedEnd } : {}), timezone: input.timezone }
  const grant = await authorizeDownstreamWrite(deps.repository, actor.organizationId, { kind: 'appointment_reschedule', subjectId: appointment.id, actorId: actor.userId, connectionRevision: ghl.revision }, payload, deadlineAt)
  if (!grant) return { allowed: false, reason: 'write_held', appointmentId: appointment.id }
  try {
    const result = await deps.ports.ghl.rescheduleAppointment(ghl.raw, payload, signal)
    const providerEnd = typeof result.receipt.endTime === 'string' ? result.receipt.endTime : computedEnd ?? null
    await deps.repository.settleAppointment(
      actor.organizationId,
      {
        ...grant, appointmentId: appointment.id,
        status: 'rescheduled',
        providerAppointmentId: result.appointmentId,
        startsAt: window.startAt,
        endsAt: providerEnd,
        receipt: result.receipt,
        expectedProviderAppointmentId: appointment.provider_appointment_id,
      },
      deadlineAt,
    )
    return { allowed: true, appointmentId: appointment.id, status: 'rescheduled', providerAppointmentId: result.appointmentId, startsAt: window.startAt, endsAt: providerEnd, receipt: result.receipt }
  } catch (error) {
    const code = error instanceof DownstreamError ? error.code : 'unexpected'
    const status = 'unknown' as const
    try {
      await deps.repository.settleAppointment(
        actor.organizationId,
        { ...grant, appointmentId: appointment.id, status, errorCode: code, expectedProviderAppointmentId: appointment.provider_appointment_id },
        deadlineAt,
      )
    } catch {
      // keep the appointment for operator reconciliation
    }
    return { allowed: false, reason: code, appointmentId: appointment.id, status }
  }
}

export async function cancelAppointment(
  actor: WinnrAuthContext,
  input: { appointmentId: string },
  deps: DownstreamServiceDeps = createDownstreamServiceDeps(),
  deadlineAt?: number,
): Promise<BookingResult> {
  requireDownstreamManager(actor)
  const read = await deps.repository.read(actor, deadlineAt)
  const appointment = read.appointments.find((entry) => entry.id === input.appointmentId)
  if (!appointment) return { allowed: false, reason: 'appointment_not_found' }
  if (!appointment.provider_appointment_id) return { allowed: false, reason: 'appointment_not_confirmed' }
  if (!['scheduled', 'rescheduled'].includes(appointment.status)) return { allowed: false, reason: 'appointment_not_active' }
  const ghl = await loadGhlConnection(actor, deps, deadlineAt)
  const signal = providerSignal(deadlineAt)
  const grant = await authorizeDownstreamWrite(deps.repository, actor.organizationId, { kind: 'appointment_cancel', subjectId: appointment.id, actorId: actor.userId, connectionRevision: ghl.revision }, { appointmentId: appointment.provider_appointment_id }, deadlineAt)
  if (!grant) return { allowed: false, reason: 'write_held', appointmentId: appointment.id }
  try {
    const result = await deps.ports.ghl.cancelAppointment(ghl.raw, appointment.provider_appointment_id, signal)
    await deps.repository.settleAppointment(
      actor.organizationId,
      { ...grant, appointmentId: appointment.id, status: 'cancelled', receipt: result.receipt, expectedProviderAppointmentId: appointment.provider_appointment_id },
      deadlineAt,
    )
    return { allowed: true, appointmentId: appointment.id, status: 'cancelled', receipt: result.receipt }
  } catch (error) {
    const code = error instanceof DownstreamError ? error.code : 'unexpected'
    const status = 'unknown' as const
    try {
      await deps.repository.settleAppointment(
        actor.organizationId,
        { ...grant, appointmentId: appointment.id, status, errorCode: code, expectedProviderAppointmentId: appointment.provider_appointment_id },
        deadlineAt,
      )
    } catch {
      // keep the appointment for operator reconciliation
    }
    return { allowed: false, reason: code, appointmentId: appointment.id, status }
  }
}
