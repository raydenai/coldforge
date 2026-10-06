/**
 * Normalized Winnr domain types.
 *
 * These are the only shapes that leave the adapter. Wire field names, unknown
 * properties and provider credentials never cross this boundary.
 *
 * Contracts derived from the public Winnr OpenAPI document
 * (`https://app.winnr.app/openapi.yaml`, downloaded 2026-10-05, SHA256
 * 675267d3d22d098b73ee5379570bd0e6badaac326e7a3e4229822e9f13c1e994) and
 * `docs/superpowers/plans/2026-10-05-winnr-launch.md` Task 2.
 */

/** Account-level plan name (e.g. `Startup`, `Enterprise`); null when absent. */
export type WinnrPlan = string | null

export interface WinnrAccount {
  id: string
  name: string
  plan: WinnrPlan
  /** API-token scopes. Empty (fail closed) when the wire omits them. */
  permissions: string[]
  universalInboxEnabled: boolean
}

export type MailboxStatus = 'active' | 'paused' | 'disabled'

export interface Mailbox {
  id: string
  email: string
  name: string | null
  status: MailboxStatus
  dailyLimit: number | null
}

export type DomainStatus = 'pending' | 'complete' | 'deleting' | 'active'
export type DnsHealth = 'healthy' | 'degraded' | 'failing'

export interface Domain {
  id: string
  name: string
  status: DomainStatus
  /** Live DNS health; null until the first check has run. */
  dnsHealth: DnsHealth | null
  checkedAt: string | null
}

export type WarmingStatus = 'active' | 'paused' | 'connecting' | 'connection_problem' | 'disabled'

export interface WarmingMailbox {
  id: string
  email: string
  status: WarmingStatus
  /** Absent metrics are null, never zero. */
  healthScore: number | null
  sent: number | null
  replies: number | null
  lastSyncedAt: string | null
}

/** Cursor-paginated page (`/v1/domains`, `/v1/email-users`, `/v1/inbox`). */
export interface CursorPage<T> {
  items: T[]
  nextCursor: string | null
  hasMore: boolean
}

/** Offset-paginated page for `/v1/warming`. */
export interface WarmingPage {
  items: WarmingMailbox[]
  page: number
  perPage: number
  total: number | null
  hasMore: boolean
}

export interface InboxMessage {
  id: string
  uid: string
  messageId: string
  threadId: string
  from: string
  to: string
  subject: string
  /** Plain-text preview, HTML stripped. */
  preview: string
  receivedAt: string
  mailbox: string
}

export type RampupSpeed = 'slow' | 'normal' | 'fast'

export interface WinnrSettings {
  emailsPerDay: number
  responseRate: number
  rampupEnabled: boolean
  rampupSpeed: RampupSpeed
}

export interface WarmingMetric {
  date: string
  sent: number | null
  inbox: number | null
  spam: number | null
  replies: number | null
  inboxRate: number | null
}

export interface ListMailboxesParams {
  cursor?: string
  limit?: number
}

export interface ListDomainsParams {
  cursor?: string
  limit?: number
}

export interface ListWarmingParams {
  page?: number
  perPage?: number
}

export interface ListInboxParams {
  /** When set, reads `/v1/email-users/{id}/inbox`; otherwise `/v1/inbox`. */
  mailboxId?: string
  cursor?: string
  limit?: number
}

export interface SendMessageInput {
  mailboxId: string
  to: string
  subject: string
  body: string
  /**
   * Wire `html` flag: when true, `body` is treated as HTML by Winnr.
   * The REST send schema has no arbitrary-header or idempotency support.
   */
  html?: boolean
  inReplyTo?: string
  references?: string
}

/** Accepted send: only ever returned when the provider said success with an id. */
export interface SendResult {
  messageId: string
}
