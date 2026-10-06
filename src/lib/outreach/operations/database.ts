import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { getServiceRoleConfig } from '@/lib/winnr/database'
import { WinnrApiError } from '@/lib/winnr/server'
import {
  OPERATIONS_PHASES,
  operationsReadinessSchema,
  operationsStatusSchema,
  type OperationsControlAction,
  type OperationsControlResult,
  type OperationsReadiness,
  type OperationsRepository,
  type OperationsSettlementInput,
  type OperationsStatus,
  phaseStatusSchema,
} from './core'

type OperationsJson = null | boolean | string | number | OperationsJson[] | { [key: string]: OperationsJson | undefined }

/** Narrow contract for the objects migration 031 adds. */
interface OperationsDatabase {
  public: {
    Tables: { [_ in never]: never }
    Views: { [_ in never]: never }
    Functions: {
      outreach_operations_claim: {
        Args: { p_lease_token: string; p_lease_seconds: number; p_org?: string | null }
        Returns: OperationsJson
      }
      outreach_operations_settle: {
        Args: {
          p_org: string
          p_scope_key: string
          p_lease_token: string
          p_lease_expires_at: string
          p_status: string
          p_reason?: string | null
          p_attempt_id?: string | null
          p_decision_id?: string | null
          p_reference_id?: string | null
          p_reference_fingerprint?: string | null
          p_model_calls?: number
          p_smtp_attempts?: number
        }
        Returns: OperationsJson
      }
      outreach_operations_readiness: { Args: { p_org: string }; Returns: OperationsJson }
      outreach_operations_mutate: {
        Args: { p_actor: string; p_org: string; p_action: string; p_payload: OperationsJson }
        Returns: OperationsJson
      }
    }
    Enums: { [_ in never]: never }
    CompositeTypes: { [_ in never]: never }
  }
}

const claimSchema = z.discriminatedUnion('result', [
  z.object({
    result: z.literal('claimed'),
    runId: z.uuid(),
    leaseToken: z.uuid(),
    leaseExpiresAt: z.string().min(1),
    organizationId: z.uuid(),
    actorId: z.uuid(),
    role: z.enum(['owner', 'admin']),
    phase: z.enum(OPERATIONS_PHASES),
    campaignId: z.uuid().nullable(),
    scopeKey: z.string().min(1),
  }),
  z.object({ result: z.literal('idle'), reason: z.string().optional() }),
  z.object({ result: z.literal('invalid') }),
])

const settleSchema = z.object({ result: z.enum(['settled', 'stale', 'not_found', 'invalid']) })

const controlResultSchema = z.object({
  saved: z.literal(true),
  revision: z.number().int().positive(),
  automationEnabled: z.boolean(),
  schedulerPaused: z.boolean(),
  masterStop: z.boolean(),
})

function operationsError(error: { message: string }): WinnrApiError {
  const code = /operations:([a-z_]+)/.exec(error.message)?.[1]
  if (code === 'forbidden') return new WinnrApiError(403, 'forbidden', 'Only owners and admins can operate automation')
  if (code === 'stale') return new WinnrApiError(409, 'conflict', 'Automation state changed; reload before retrying')
  if (code === 'not_found') return new WinnrApiError(404, 'bad_request', 'Automation resource not found')
  return new WinnrApiError(400, 'bad_request', 'Automation operation was not accepted')
}

/** Per-call storage budget: never the fixed cap nor the request deadline. */
function storageSignal(deadlineAt: number | undefined, capMs = 8000): AbortSignal {
  if (deadlineAt === undefined) return AbortSignal.timeout(capMs)
  return AbortSignal.timeout(Math.max(1, Math.min(capMs, deadlineAt - Date.now())))
}

export interface OperationsRepositoryOptions {
  client?: SupabaseClient<OperationsDatabase>
}

export function createOperationsRepository(options: OperationsRepositoryOptions = {}): OperationsRepository {
  const client =
    options.client ??
    (() => {
      const config = getServiceRoleConfig()
      return createClient<OperationsDatabase>(config.url, config.serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        global: {
          fetch: (input, init) => {
            const fallback = AbortSignal.timeout(8000)
            const signal = init?.signal ? AbortSignal.any([init.signal, fallback]) : fallback
            return fetch(input, { ...init, signal })
          },
        },
      })
    })()

  return {
    async claim(input) {
      const { data, error } = await client
        .rpc('outreach_operations_claim', {
          p_lease_token: input.leaseToken,
          p_lease_seconds: input.leaseSeconds,
          p_org: input.organizationId ?? null,
        })
        .abortSignal(storageSignal(input.deadlineAt))
      if (error) throw new WinnrApiError(503, 'service_unavailable', 'Automation claim storage is unavailable')
      const parsed = claimSchema.safeParse(data)
      if (!parsed.success) throw new WinnrApiError(503, 'service_unavailable', 'Automation claim returned an unexpected result')
      if (parsed.data.result === 'claimed') return parsed.data
      return { result: 'idle', reason: parsed.data.result === 'idle' ? (parsed.data.reason ?? 'idle') : 'invalid' }
    },

    async settle(input: OperationsSettlementInput) {
      const { data, error } = await client
        .rpc('outreach_operations_settle', {
          p_org: input.organizationId,
          p_scope_key: input.scopeKey,
          p_lease_token: input.leaseToken,
          p_lease_expires_at: input.leaseExpiresAt,
          p_status: input.status,
          p_reason: input.reason ?? null,
          p_attempt_id: input.attemptId ?? null,
          p_decision_id: input.decisionId ?? null,
          p_reference_id: input.referenceId ?? null,
          p_reference_fingerprint: input.referenceFingerprint ?? null,
          p_model_calls: input.modelCalls,
          p_smtp_attempts: input.smtpAttempts,
        })
        .abortSignal(storageSignal(input.deadlineAt))
      if (error) throw new WinnrApiError(503, 'service_unavailable', 'Automation settlement storage is unavailable')
      const parsed = settleSchema.safeParse(data)
      if (!parsed.success) throw new WinnrApiError(503, 'service_unavailable', 'Automation settlement returned an unexpected result')
      return parsed.data
    },

    async read(actor, deadlineAt): Promise<OperationsStatus> {
      const { data, error } = await client
        .rpc('outreach_operations_mutate', {
          p_actor: actor.userId,
          p_org: actor.organizationId,
          p_action: 'read',
          p_payload: {},
        })
        .abortSignal(storageSignal(deadlineAt))
      if (error) throw operationsError(error)
      return operationsStatusSchema.parse(data)
    },

    async readiness(actor, deadlineAt): Promise<OperationsReadiness> {
      const { data, error } = await client
        .rpc('outreach_operations_readiness', { p_org: actor.organizationId })
        .abortSignal(storageSignal(deadlineAt))
      if (error) throw new WinnrApiError(503, 'service_unavailable', 'Automation readiness storage is unavailable')
      return operationsReadinessSchema.parse(data)
    },

    async control(actor, action: OperationsControlAction, expectedRevision, deadlineAt): Promise<OperationsControlResult> {
      const { data, error } = await client
        .rpc('outreach_operations_mutate', {
          p_actor: actor.userId,
          p_org: actor.organizationId,
          p_action: action,
          p_payload: { expectedRevision },
        })
        .abortSignal(storageSignal(deadlineAt))
      if (error) throw operationsError(error)
      const parsed = controlResultSchema.safeParse(data)
      if (!parsed.success) throw new WinnrApiError(503, 'service_unavailable', 'Automation control returned an unexpected result')
      return {
        revision: parsed.data.revision,
        automationEnabled: parsed.data.automationEnabled,
        schedulerPaused: parsed.data.schedulerPaused,
        masterStop: parsed.data.masterStop,
      }
    },
  }
}

/** Re-exported for callers that only need the validated settlement status. */
export { phaseStatusSchema }
