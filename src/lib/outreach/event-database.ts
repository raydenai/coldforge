/**
 * Service-role outreach event/outbox storage adapter (plan Wave 2).
 *
 * The new objects are not in the generated `Database` type yet, so this file
 * declares a narrow, explicit contract for exactly the objects migration 021
 * adds. No `any` and no anon fallback: a missing service-role key is an explicit
 * configuration error, never a silent downgrade.
 *
 * All state transitions go through the SECURITY DEFINER RPCs; the adapter never
 * writes the tables directly, so browser-facing policies cannot be bypassed by
 * a caller and all validation/locking stays in one place.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import {
  normalizeOutreachEvent,
  OutreachEventError,
  type AckOutboxResult,
  type AppendEventRepositoryInput,
  type AppendEventResult,
  type ClaimOutboxRepositoryInput,
  type ClaimOutboxResult,
  type FailOutboxRepositoryInput,
  type FailOutboxResult,
  type MarkUnknownRepositoryInput,
  type MarkUnknownResult,
  type OutreachEventRepository,
  type OutreachEventV1,
  type OutreachOutboxJob,
  type SettleOutboxRepositoryInput,
} from './events'

export class OutreachConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OutreachConfigError'
  }
}

type OutreachJson = string | number | boolean | null | OutreachJson[] | { [key: string]: OutreachJson }

type OutreachEventRow = {
  id: string
  organization_id: string
  type: string
  source: string
  source_event_id: string
  occurred_at: string
  correlation_id: string | null
  causation_id: string | null
  lead_id: string | null
  campaign_id: string | null
  message_id: string | null
  appointment_id: string | null
  data: OutreachJson
  fingerprint: string
  created_at: string
}

type OutreachOutboxRow = {
  id: string
  organization_id: string
  event_id: string
  consumer: string
  status: string
  attempts: number
  max_attempts: number
  available_at: string
  lease_token: string | null
  lease_expires_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}

/** Narrow contract for migration 021 only. */
export interface OutreachDatabase {
  public: {
    Tables: {
      outreach_events: {
        Row: OutreachEventRow
        Insert: Partial<OutreachEventRow> & {
          organization_id: string
          type: string
          source: string
          source_event_id: string
          occurred_at: string
          fingerprint: string
        }
        Update: Partial<OutreachEventRow>
        Relationships: []
      }
      outreach_outbox: {
        Row: OutreachOutboxRow
        Insert: Partial<OutreachOutboxRow> & {
          organization_id: string
          event_id: string
          consumer: string
        }
        Update: Partial<OutreachOutboxRow>
        Relationships: []
      }
    }
    Views: { [_ in never]: never }
    Functions: {
      outreach_append_event: {
        Args: {
          p_organization_id: string
          p_event: OutreachEventV1
          p_consumers: string[]
          p_fingerprint: string
        }
        Returns: OutreachJson
      }
      outreach_claim_outbox: {
        Args: {
          p_organization_id: string
          p_consumer: string
          p_lease_token: string
          p_lease_seconds: number
          p_limit: number
        }
        Returns: OutreachJson
      }
      outreach_ack_outbox: {
        Args: {
          p_organization_id: string
          p_outbox_id: string
          p_lease_token: string
          p_lease_expires_at: string
        }
        Returns: OutreachJson
      }
      outreach_fail_outbox: {
        Args: {
          p_organization_id: string
          p_outbox_id: string
          p_lease_token: string
          p_lease_expires_at: string
          p_error_code: string | null
          p_retryable: boolean
        }
        Returns: OutreachJson
      }
      outreach_mark_unknown: {
        Args: {
          p_organization_id: string
          p_outbox_id: string
          p_lease_token: string
          p_lease_expires_at: string
          p_reason: string | null
        }
        Returns: OutreachJson
      }
      outreach_expire_leases: {
        Args: { p_organization_id: string }
        Returns: number
      }
    }
    Enums: { [_ in never]: never }
    CompositeTypes: { [_ in never]: never }
  }
}

export function getOutreachServiceRoleConfig(): { url: string; serviceRoleKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || url.trim() === '' || !serviceRoleKey || serviceRoleKey.trim() === '') {
    // No secret or URL value is included in the error.
    throw new OutreachConfigError('Outreach event storage is not configured')
  }
  return { url, serviceRoleKey }
}

const appendResultSchema = z.object({
  result: z.enum(['created', 'duplicate', 'conflict', 'invalid']),
  event_id: z.string().min(1).optional(),
  reason: z.string().optional(),
})

const jobSchema = z.object({
  outboxId: z.string().min(1),
  eventId: z.string().min(1),
  attempts: z.number().int().nonnegative(),
  leaseExpiresAt: z.string().min(1),
  event: z.unknown(),
})

const claimResultSchema = z.object({
  result: z.enum(['claimed', 'invalid']),
  jobs: z.array(jobSchema).default([]),
  reason: z.string().optional(),
})

const ackResultSchema = z.object({ result: z.enum(['acked', 'stale', 'not_found', 'invalid']) })
const failResultSchema = z.object({
  result: z.enum(['retryable', 'failed', 'stale', 'not_found', 'invalid']),
  attempts: z.number().int().nonnegative().optional(),
})
const unknownResultSchema = z.object({ result: z.enum(['unknown', 'stale', 'not_found', 'invalid']) })

function parseJson(value: OutreachJson | null): unknown {
  if (value === null) return null
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }
  return value
}

export interface OutreachRepositoryOptions {
  client?: SupabaseClient<OutreachDatabase>
}

/**
 * Upper bound for one 021 RPC once a caller supplies an absolute request
 * deadline. The deadline is only ever used for the per-call abort signal, so
 * no lease, fencing, dedupe or fingerprint semantics change.
 */
const OUTREACH_RPC_MAX_MS = 8000

function rpcAbortSignal(deadlineAt: number | undefined): AbortSignal | undefined {
  if (deadlineAt === undefined) return undefined
  const remaining = deadlineAt - Date.now()
  if (remaining <= 0) return AbortSignal.abort()
  return AbortSignal.timeout(Math.max(1, Math.min(OUTREACH_RPC_MAX_MS, remaining)))
}

export function createOutreachEventRepository(
  options: OutreachRepositoryOptions = {}
): OutreachEventRepository {
  const client =
    options.client ??
    (() => {
      const { url, serviceRoleKey } = getOutreachServiceRoleConfig()
      return createClient<OutreachDatabase>(url, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    })()

  function parseAppendPayload(data: OutreachJson | null): AppendEventResult {
    const parsed = appendResultSchema.safeParse(parseJson(data))
    if (!parsed.success) throw new OutreachEventError('Outreach storage returned an unexpected result')
    if (parsed.data.result === 'invalid') {
      throw new OutreachEventError(`Outreach storage rejected the append: ${parsed.data.reason ?? 'invalid'}`)
    }
    if (!parsed.data.event_id) {
      throw new OutreachEventError('Outreach storage returned an incomplete result')
    }
    return { result: parsed.data.result, eventId: parsed.data.event_id }
  }

  return {
    async appendEvent(input: AppendEventRepositoryInput): Promise<AppendEventResult> {
      const { data, error } = await client.rpc('outreach_append_event', {
        p_organization_id: input.organizationId,
        p_event: input.event,
        p_consumers: input.consumers,
        p_fingerprint: input.fingerprint,
      })
      if (error) throw new OutreachEventError('Outreach storage append failed')
      return parseAppendPayload(data)
    },

    async claimOutbox(input: ClaimOutboxRepositoryInput): Promise<ClaimOutboxResult> {
      const signal = rpcAbortSignal(input.deadlineAt)
      const query = client.rpc('outreach_claim_outbox', {
        p_organization_id: input.organizationId,
        p_consumer: input.consumer,
        p_lease_token: input.leaseToken,
        p_lease_seconds: input.leaseSeconds,
        p_limit: input.limit,
      })
      const { data, error } = await (signal ? query.abortSignal(signal) : query)
      if (error) throw new OutreachEventError('Outreach storage claim failed')
      const parsed = claimResultSchema.safeParse(parseJson(data))
      if (!parsed.success) throw new OutreachEventError('Outreach storage returned an unexpected result')
      if (parsed.data.result === 'invalid') {
        throw new OutreachEventError(`Outreach storage rejected the claim: ${parsed.data.reason ?? 'invalid'}`)
      }
      const jobs: OutreachOutboxJob[] = parsed.data.jobs.map((job) => ({
        outboxId: job.outboxId,
        eventId: job.eventId,
        attempts: job.attempts,
        leaseExpiresAt: job.leaseExpiresAt,
        event: normalizeOutreachEvent(job.event),
      }))
      return { result: 'claimed', jobs }
    },

    async ackOutbox(input: SettleOutboxRepositoryInput): Promise<AckOutboxResult> {
      const signal = rpcAbortSignal(input.deadlineAt)
      const query = client.rpc('outreach_ack_outbox', {
        p_organization_id: input.organizationId,
        p_outbox_id: input.outboxId,
        p_lease_token: input.leaseToken,
        p_lease_expires_at: input.leaseExpiresAt,
      })
      const { data, error } = await (signal ? query.abortSignal(signal) : query)
      if (error) throw new OutreachEventError('Outreach storage acknowledgement failed')
      const parsed = ackResultSchema.safeParse(parseJson(data))
      if (!parsed.success || parsed.data.result === 'invalid') {
        throw new OutreachEventError('Outreach storage returned an unexpected result')
      }
      return { result: parsed.data.result }
    },

    async failOutbox(input: FailOutboxRepositoryInput): Promise<FailOutboxResult> {
      const signal = rpcAbortSignal(input.deadlineAt)
      const query = client.rpc('outreach_fail_outbox', {
        p_organization_id: input.organizationId,
        p_outbox_id: input.outboxId,
        p_lease_token: input.leaseToken,
        p_lease_expires_at: input.leaseExpiresAt,
        p_error_code: input.errorCode,
        p_retryable: input.retryable,
      })
      const { data, error } = await (signal ? query.abortSignal(signal) : query)
      if (error) throw new OutreachEventError('Outreach storage failure report failed')
      const parsed = failResultSchema.safeParse(parseJson(data))
      if (!parsed.success || parsed.data.result === 'invalid') {
        throw new OutreachEventError('Outreach storage returned an unexpected result')
      }
      return parsed.data.attempts === undefined
        ? { result: parsed.data.result }
        : { result: parsed.data.result, attempts: parsed.data.attempts }
    },

    async markUnknown(input: MarkUnknownRepositoryInput): Promise<MarkUnknownResult> {
      const signal = rpcAbortSignal(input.deadlineAt)
      const query = client.rpc('outreach_mark_unknown', {
        p_organization_id: input.organizationId,
        p_outbox_id: input.outboxId,
        p_lease_token: input.leaseToken,
        p_lease_expires_at: input.leaseExpiresAt,
        p_reason: input.reason,
      })
      const { data, error } = await (signal ? query.abortSignal(signal) : query)
      if (error) throw new OutreachEventError('Outreach storage unknown report failed')
      const parsed = unknownResultSchema.safeParse(parseJson(data))
      if (!parsed.success || parsed.data.result === 'invalid') {
        throw new OutreachEventError('Outreach storage returned an unexpected result')
      }
      return { result: parsed.data.result }
    },
  }
}
