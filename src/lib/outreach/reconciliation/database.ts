import { createClient } from '@supabase/supabase-js'
import type { Json } from '@/types/database'
import { z } from 'zod'
import { WinnrApiError } from '@/lib/winnr/server'

const json: z.ZodType<Json> = z.lazy(() =>
  z.union([z.null(), z.string(), z.boolean(), z.number(), z.array(json), z.record(z.string(), json)]),
)

export type ReconciliationAction = 'list' | 'status' | 'reconcile'

export interface ReconciliationRepository {
  call(actor: string, org: string, action: ReconciliationAction, payload: Record<string, unknown>): Promise<unknown>
}

/**
 * Narrow contract for the single 032 service-only RPC. The generated database
 * type does not describe the new function yet, so this is explicit and
 * minimal: no anon fallback and no ambient table access.
 */
interface ReconciliationDatabase {
  public: {
    Tables: Record<string, never>
    Views: Record<string, never>
    Functions: {
      outreach_reconciliation_mutate: {
        Args: { p_actor: string; p_org: string; p_action: string; p_payload: Json }
        Returns: Json
      }
    }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}

export function createReconciliationRepository(): ReconciliationRepository {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new WinnrApiError(503, 'service_unavailable', 'Reconciliation storage is not configured')
  const client = createClient<ReconciliationDatabase>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(4000) }) },
  })
  return {
    async call(actor, org, action, payload) {
      const clean = Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined))
      const { data, error } = await client.rpc('outreach_reconciliation_mutate', {
        p_actor: actor,
        p_org: org,
        p_action: action,
        p_payload: json.parse(clean),
      })
      if (error) {
        if (error.message.includes('reconciliation:forbidden')) throw new WinnrApiError(403, 'forbidden', 'Owner or admin required')
        if (error.message.includes('reconciliation:not_found')) throw new WinnrApiError(404, 'bad_request', 'Held attempt not found')
        if (error.message.includes('reconciliation:audit_immutable')) throw new WinnrApiError(500, 'internal_error', 'Reconciliation audit is immutable')
        throw new WinnrApiError(503, 'service_unavailable', 'Reconciliation storage failed')
      }
      return data
    },
  }
}
