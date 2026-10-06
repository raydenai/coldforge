/**
 * Storage adapter for the bounded downstream module. All writes go through the
 * SECURITY DEFINER RPCs in migration 033; the browser-facing read never touches
 * the credential ciphertext.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { getServiceRoleConfig } from '@/lib/winnr/database'
import { WinnrApiError } from '@/lib/winnr/server'
import {
  bookingResultSchema,
  connectionSecretSchema,
  downstreamReadSchema,
  effectContextSchema,
  effectReserveResultSchema,
  nextEffectSchema,
  nextOrgSchema,
  type DownstreamProvider,
  type DownstreamRead,
} from './core'

type DownstreamJson = null | boolean | string | number | DownstreamJson[] | { [key: string]: DownstreamJson | undefined }

interface DownstreamDatabase {
  public: {
    Tables: { [_ in never]: never }
    Views: { [_ in never]: never }
    Functions: {
      outreach_downstream_mutate: {
        Args: { p_actor: string; p_org: string; p_action: string; p_payload: DownstreamJson }
        Returns: DownstreamJson
      }
      outreach_downstream_effect: {
        Args: { p_org: string; p_action: string; p_payload: DownstreamJson }
        Returns: DownstreamJson
      }
      outreach_downstream_next_org: { Args: Record<string, never>; Returns: DownstreamJson }
    }
    Enums: { [_ in never]: never }
    CompositeTypes: { [_ in never]: never }
  }
}

function storageSignal(deadlineAt: number | undefined, capMs = 8000): AbortSignal {
  if (deadlineAt === undefined) return AbortSignal.timeout(capMs)
  return AbortSignal.timeout(Math.max(1, Math.min(capMs, deadlineAt - Date.now())))
}

function downstreamError(error: { message: string }): WinnrApiError {
  const code = /downstream:([a-z_]+)/.exec(error.message)?.[1]
  if (code === 'forbidden') return new WinnrApiError(403, 'forbidden', 'Only owners and admins can manage downstream integrations')
  if (code === 'stale') return new WinnrApiError(409, 'conflict', 'Downstream configuration changed; reload before retrying')
  if (code === 'conflict') return new WinnrApiError(409, 'conflict', 'A webhook event with the same identity but a different payload was rejected')
  if (code === 'not_found') return new WinnrApiError(404, 'bad_request', 'Downstream resource not found')
  return new WinnrApiError(400, 'bad_request', 'Downstream operation was not accepted')
}

export interface DownstreamRepository {
  read(actor: { userId: string; organizationId: string }, deadlineAt?: number): Promise<DownstreamRead>
  mutate(actor: { userId: string; organizationId: string }, action: string, payload: Record<string, unknown>, deadlineAt?: number): Promise<Record<string, unknown>>
  effect(organizationId: string, action: string, payload: Record<string, unknown>, deadlineAt?: number): Promise<Record<string, unknown>>
  nextOrg(deadlineAt?: number): Promise<{ organizationId: string; actorId: string } | null>
  reserveEffect(organizationId: string, payload: Record<string, unknown>, deadlineAt?: number): Promise<ReturnType<typeof effectReserveResultSchema.parse>>
  settleEffect(organizationId: string, payload: Record<string, unknown>, deadlineAt?: number): Promise<void>
  claimEffect(organizationId: string, leaseSeconds: number, deadlineAt?: number): Promise<ReturnType<typeof nextEffectSchema.parse>>
  effectContext(organizationId: string, effectId: string, dispatchToken: string, deadlineAt?: number): Promise<ReturnType<typeof effectContextSchema.parse>>
  reserveCallback(organizationId: string, payload: Record<string, unknown>, deadlineAt?: number): Promise<Record<string, unknown>>
  settleCallback(organizationId: string, payload: Record<string, unknown>, deadlineAt?: number): Promise<void>
  reserveAppointment(organizationId: string, payload: Record<string, unknown>, deadlineAt?: number): Promise<ReturnType<typeof bookingResultSchema.parse>>
  settleAppointment(organizationId: string, payload: Record<string, unknown>, deadlineAt?: number): Promise<void>
  reviewBridge(actor: { userId: string; organizationId: string }, payload: Record<string, unknown>, deadlineAt?: number): Promise<Record<string, unknown>>
  recordInboundBridge(organizationId: string, payload: Record<string, unknown>, deadlineAt?: number): Promise<Record<string, unknown>>
  recordCrmLink(organizationId: string, payload: Record<string, unknown>, deadlineAt?: number): Promise<Record<string, unknown>>
  recordWebhookEvent(organizationId: string, payload: Record<string, unknown>, deadlineAt?: number): Promise<Record<string, unknown>>
  recordProviderQualification(organizationId: string, payload: Record<string, unknown>, deadlineAt?: number): Promise<Record<string, unknown>>
  connectionSecret(organizationId: string, provider: DownstreamProvider, deadlineAt?: number): Promise<ReturnType<typeof connectionSecretSchema.parse>>
}

export interface DownstreamRepositoryOptions {
  client?: SupabaseClient<DownstreamDatabase>
}

export function createDownstreamRepository(options: DownstreamRepositoryOptions = {}): DownstreamRepository {
  const client =
    options.client ??
    (() => {
      const config = getServiceRoleConfig()
      return createClient<DownstreamDatabase>(config.url, config.serviceRoleKey, {
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

  const effect = async (organizationId: string, action: string, payload: Record<string, unknown>, deadlineAt?: number) => {
    const { data, error } = await client
      .rpc('outreach_downstream_effect', { p_org: organizationId, p_action: action, p_payload: payload as DownstreamJson })
      .abortSignal(storageSignal(deadlineAt))
    if (error) throw new WinnrApiError(503, 'service_unavailable', 'Downstream storage is unavailable')
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new WinnrApiError(503, 'service_unavailable', 'Downstream storage returned an unexpected result')
    }
    return data as Record<string, unknown>
  }

  return {
    async read(actor, deadlineAt) {
      const { data, error } = await client
        .rpc('outreach_downstream_mutate', { p_actor: actor.userId, p_org: actor.organizationId, p_action: 'read', p_payload: {} })
        .abortSignal(storageSignal(deadlineAt))
      if (error) throw downstreamError(error)
      return downstreamReadSchema.parse(data)
    },
    async mutate(actor, action, payload, deadlineAt) {
      const { data, error } = await client
        .rpc('outreach_downstream_mutate', { p_actor: actor.userId, p_org: actor.organizationId, p_action: action, p_payload: payload as DownstreamJson })
        .abortSignal(storageSignal(deadlineAt))
      if (error) throw downstreamError(error)
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        throw new WinnrApiError(503, 'service_unavailable', 'Downstream storage returned an unexpected result')
      }
      return data as Record<string, unknown>
    },
    effect,
    async nextOrg(deadlineAt) {
      const { data, error } = await client.rpc('outreach_downstream_next_org').abortSignal(storageSignal(deadlineAt))
      if (error) throw new WinnrApiError(503, 'service_unavailable', 'Downstream scheduler storage is unavailable')
      return nextOrgSchema.parse(data)
    },
    async reserveEffect(organizationId, payload, deadlineAt) {
      return effectReserveResultSchema.parse(await effect(organizationId, 'reserveEffect', payload, deadlineAt))
    },
    async settleEffect(organizationId, payload, deadlineAt) {
      const result = await effect(organizationId, 'settleEffect', payload, deadlineAt)
      if (result.result !== 'settled') throw new WinnrApiError(409, 'conflict', 'Downstream effect settlement was stale')
    },
    async claimEffect(organizationId, leaseSeconds, deadlineAt) {
      return nextEffectSchema.parse(await effect(organizationId, 'claimEffect', { leaseSeconds }, deadlineAt))
    },
    async effectContext(organizationId, effectId, dispatchToken, deadlineAt) {
      return effectContextSchema.parse(await effect(organizationId, 'effectContext', { effectId, dispatchToken }, deadlineAt))
    },
    reserveCallback(organizationId, payload, deadlineAt) {
      return effect(organizationId, 'reserveCallback', payload, deadlineAt)
    },
    async settleCallback(organizationId, payload, deadlineAt) {
      const result = await effect(organizationId, 'settleCallback', payload, deadlineAt)
      if (result.result !== 'settled') throw new WinnrApiError(409, 'conflict', 'Downstream callback settlement was stale')
    },
    async reserveAppointment(organizationId, payload, deadlineAt) {
      return bookingResultSchema.parse(await effect(organizationId, 'reserveAppointment', payload, deadlineAt))
    },
    async settleAppointment(organizationId, payload, deadlineAt) {
      const result = await effect(organizationId, 'settleAppointment', payload, deadlineAt)
      if (result.result !== 'settled') throw new WinnrApiError(409, 'conflict', 'Downstream appointment settlement was stale')
    },
    reviewBridge(actor, payload, deadlineAt) {
      return this.mutate(actor, 'reviewBridge', payload, deadlineAt)
    },
    recordInboundBridge(organizationId, payload, deadlineAt) {
      return effect(organizationId, 'recordInboundBridge', payload, deadlineAt)
    },
    recordCrmLink(organizationId, payload, deadlineAt) {
      return effect(organizationId, 'recordCrmLink', payload, deadlineAt)
    },
    recordWebhookEvent(organizationId, payload, deadlineAt) {
      return effect(organizationId, 'recordWebhookEvent', payload, deadlineAt)
    },
    recordProviderQualification(organizationId, payload, deadlineAt) {
      return effect(organizationId, 'recordProviderQualification', payload, deadlineAt)
    },
    async connectionSecret(organizationId, provider, deadlineAt) {
      return connectionSecretSchema.parse(await effect(organizationId, 'connectionSecret', { provider }, deadlineAt))
    },
  }
}

export const downstreamProviderSchema = z.enum(['ghl', 'closebot', 'retell'])
export type { DownstreamProvider }
