/**
 * Service-role Winnr storage adapter (launch plan Task 3).
 *
 * The new tables/functions are not in the generated `Database` type yet, so
 * this file declares a narrow, explicit contract for exactly the objects
 * migration 020 adds. No `any` and no anon fallback: a missing service-role key
 * is an explicit configuration error, never a silent downgrade.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { decrypt } from '@/lib/encryption'
import {
  WinnrApiError,
  type DeleteConnectionInput,
  type DeleteConnectionResult,
  type ReserveOperationInput,
  type ReserveResult,
  type SaveConnectionInput,
  type SaveConnectionResult,
  type SettleOperationInput,
  type WinnrConnectionRecord,
  type WinnrRepository,
} from './server'

export class WinnrConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WinnrConfigError'
  }
}

type WinnrJson = string | number | boolean | null | WinnrJson[] | { [key: string]: WinnrJson }

type WinnrConnectionRow = {
  id: string
  organization_id: string
  provider_account_id: string
  token_ciphertext: string
  account_name: string
  account_plan: string | null
  permissions: string[]
  universal_inbox_enabled: boolean
  version: number
  connected_at: string
  verified_at: string
  updated_at: string
}

type WinnrOperationRow = {
  id: string
  organization_id: string
  connection_id: string | null
  connection_version: number
  action: string
  mailbox_ids: string[]
  status: string
  request_fingerprint: string
  error_code: string | null
  created_at: string
  updated_at: string
  settled_at: string | null
}

/** Narrow contract for migration 020 only. */
export interface WinnrDatabase {
  public: {
    Tables: {
      winnr_connections: {
        Row: WinnrConnectionRow
        Insert: Partial<WinnrConnectionRow> & {
          organization_id: string
          provider_account_id: string
          token_ciphertext: string
        }
        Update: Partial<WinnrConnectionRow>
        Relationships: []
      }
      winnr_operations: {
        Row: WinnrOperationRow
        Insert: Partial<WinnrOperationRow> & { id: string; organization_id: string }
        Update: Partial<WinnrOperationRow>
        Relationships: []
      }
    }
    Views: { [_ in never]: never }
    Functions: {
      winnr_reserve_operation: {
        Args: {
          p_organization_id: string
          p_operation_id: string
          p_connection_id: string
          p_connection_version: number
          p_action: string
          p_mailbox_ids: string[]
          p_fingerprint: string
        }
        Returns: WinnrJson
      }
      winnr_settle_operation: {
        Args: {
          p_organization_id: string
          p_operation_id: string
          p_status: string
          p_error_code: string | null
        }
        Returns: boolean
      }
      winnr_save_connection: {
        Args: {
          p_organization_id: string
          p_provider_account_id: string
          p_token_ciphertext: string
          p_account_name: string
          p_account_plan: string | null
          p_permissions: string[]
          p_universal_inbox_enabled: boolean
          p_expected_connection_id: string | null
          p_expected_version: number | null
        }
        Returns: WinnrJson
      }
      winnr_delete_connection: {
        Args: {
          p_organization_id: string
          p_expected_connection_id: string
          p_expected_version: number
        }
        Returns: WinnrJson
      }
    }
    Enums: { [_ in never]: never }
    CompositeTypes: { [_ in never]: never }
  }
}

export function getServiceRoleConfig(): { url: string; serviceRoleKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || url.trim() === '' || !serviceRoleKey || serviceRoleKey.trim() === '') {
    // No secret or URL value is included in the error.
    throw new WinnrConfigError('Winnr storage is not configured')
  }
  return { url, serviceRoleKey }
}

const reserveResultSchema = z.object({
  result: z.enum([
    'reserved',
    'duplicate',
    'fingerprint_mismatch',
    'operation_id_conflict',
    'blocked',
    'stale',
    'not_found',
  ]),
  operation_status: z.enum(['pending', 'succeeded', 'rejected', 'unknown']).optional(),
  operation_id: z.string().nullish(),
})

const saveResultSchema = z.object({
  result: z.enum(['saved', 'stale', 'blocked', 'account_taken']),
  connection_id: z.string().optional(),
  version: z.number().optional(),
})

const deleteResultSchema = z.object({
  result: z.enum(['deleted', 'stale', 'blocked', 'not_found']),
})

function parseJson(value: WinnrJson | null): unknown {
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

function toRecord(row: WinnrConnectionRow): WinnrConnectionRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    version: row.version,
    providerAccountId: row.provider_account_id,
    accountName: row.account_name,
    accountPlan: row.account_plan,
    permissions: Array.isArray(row.permissions) ? row.permissions : [],
    universalInboxEnabled: row.universal_inbox_enabled,
    connectedAt: row.connected_at,
    verifiedAt: row.verified_at,
  }
}

const CONNECTION_COLUMNS =
  'id, organization_id, provider_account_id, token_ciphertext, account_name, account_plan, permissions, universal_inbox_enabled, version, connected_at, verified_at'

/** Cap for a single read bounded by an absolute deadline. */
const READ_DEADLINE_CAP_MS = 8000

export interface ServiceRoleRepositoryOptions {
  client?: SupabaseClient<WinnrDatabase>
  /**
   * Absolute epoch-ms deadline for the read-only connection/token lookup used
   * by `requireConnection`. It is never persisted, logged or used to change
   * identity/version validation. Absent ⇒ the historical unbounded read.
   */
  deadlineAt?: number
  /** Optional caller cancellation combined with the deadline bound. */
  signal?: AbortSignal
}

export function createServiceRoleRepository(
  options: ServiceRoleRepositoryOptions = {}
): WinnrRepository {
  const client =
    options.client ??
    (() => {
      const { url, serviceRoleKey } = getServiceRoleConfig()
      return createClient<WinnrDatabase>(url, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    })()

  // The caller signal and the absolute deadline are combined (never replaced)
  // and handed to the SDK fetch, so the abort stays active while the response
  // body is consumed. No deadline and no caller signal ⇒ no `abortSignal`, so
  // the default path is byte-for-byte the historical read.
  function readSignal(): AbortSignal | undefined {
    const signals: AbortSignal[] = []
    if (options.signal) signals.push(options.signal)
    if (options.deadlineAt !== undefined) {
      const remaining = options.deadlineAt - Date.now()
      signals.push(
        remaining <= 0
          ? AbortSignal.abort()
          : AbortSignal.timeout(Math.max(1, Math.min(READ_DEADLINE_CAP_MS, remaining)))
      )
    }
    if (signals.length === 0) return undefined
    return signals.length === 1 ? signals[0] : AbortSignal.any(signals)
  }

  async function selectConnection(organizationId: string): Promise<WinnrConnectionRow | null> {
    // Fail closed before any DB call when the budget is already gone or the
    // caller has already cancelled.
    if (options.deadlineAt !== undefined && options.deadlineAt - Date.now() <= 0) {
      throw new WinnrApiError(503, 'service_unavailable', 'Winnr storage deadline exceeded')
    }
    if (options.signal?.aborted) {
      throw new WinnrApiError(503, 'service_unavailable', 'Winnr storage read cancelled')
    }
    const select = client
      .from('winnr_connections')
      .select(CONNECTION_COLUMNS)
      .eq('organization_id', organizationId)
    const signal = readSignal()
    const { data, error } = await (signal ? select.abortSignal(signal).maybeSingle() : select.maybeSingle())
    if (error) throw new WinnrConfigError('Winnr storage query failed')
    return (data as WinnrConnectionRow | null) ?? null
  }

  return {
    async getConnection(organizationId: string): Promise<WinnrConnectionRecord | null> {
      const row = await selectConnection(organizationId)
      return row ? toRecord(row) : null
    },

    async getConnectionWithToken(organizationId: string): Promise<{
      connection: WinnrConnectionRecord
      token: string
    } | null> {
      const row = await selectConnection(organizationId)
      if (!row) return null
      let token: string
      try {
        token = decrypt(row.token_ciphertext)
      } catch {
        throw new WinnrConfigError('Stored Winnr credential could not be read')
      }
      return { connection: toRecord(row), token }
    },

    async saveConnection(input: SaveConnectionInput): Promise<SaveConnectionResult> {
      const { data, error } = await client.rpc('winnr_save_connection', {
        p_organization_id: input.organizationId,
        p_provider_account_id: input.providerAccountId,
        p_token_ciphertext: input.tokenCiphertext,
        p_account_name: input.accountName,
        p_account_plan: input.accountPlan,
        p_permissions: input.permissions,
        p_universal_inbox_enabled: input.universalInboxEnabled,
        p_expected_connection_id: input.expectedConnectionId,
        p_expected_version: input.expectedVersion,
      })
      if (error) throw new WinnrConfigError('Winnr storage write failed')
      const parsed = saveResultSchema.safeParse(parseJson(data))
      if (!parsed.success || parsed.data.result !== 'saved') {
        if (parsed.success && parsed.data.result !== 'saved') {
          return { result: parsed.data.result }
        }
        throw new WinnrConfigError('Winnr storage returned an unexpected result')
      }
      if (!parsed.data.connection_id || typeof parsed.data.version !== 'number') {
        throw new WinnrConfigError('Winnr storage returned an incomplete result')
      }
      return { result: 'saved', connectionId: parsed.data.connection_id, version: parsed.data.version }
    },

    async deleteConnection(input: DeleteConnectionInput): Promise<DeleteConnectionResult> {
      const { data, error } = await client.rpc('winnr_delete_connection', {
        p_organization_id: input.organizationId,
        p_expected_connection_id: input.expectedConnectionId,
        p_expected_version: input.expectedVersion,
      })
      if (error) throw new WinnrConfigError('Winnr storage delete failed')
      const parsed = deleteResultSchema.safeParse(parseJson(data))
      if (!parsed.success) throw new WinnrConfigError('Winnr storage returned an unexpected result')
      return { result: parsed.data.result }
    },

    async reserveOperation(input: ReserveOperationInput): Promise<ReserveResult> {
      const { data, error } = await client.rpc('winnr_reserve_operation', {
        p_organization_id: input.organizationId,
        p_operation_id: input.operationId,
        p_connection_id: input.connectionId,
        p_connection_version: input.connectionVersion,
        p_action: input.action,
        p_mailbox_ids: input.mailboxIds,
        p_fingerprint: input.fingerprint,
      })
      if (error) throw new WinnrConfigError('Winnr storage reservation failed')
      const parsed = reserveResultSchema.safeParse(parseJson(data))
      if (!parsed.success) throw new WinnrConfigError('Winnr storage returned an unexpected result')
      const { result, operation_status, operation_id } = parsed.data
      switch (result) {
        case 'reserved':
          return { result: 'reserved' }
        case 'duplicate':
          if (!operation_status) throw new WinnrConfigError('Winnr storage returned an incomplete result')
          return { result: 'duplicate', status: operation_status }
        case 'blocked':
          if (!operation_status) throw new WinnrConfigError('Winnr storage returned an incomplete result')
          return { result: 'blocked', status: operation_status, operationId: operation_id ?? null }
        case 'fingerprint_mismatch':
          return { result: 'fingerprint_mismatch' }
        case 'operation_id_conflict':
          return { result: 'operation_id_conflict' }
        case 'stale':
          return { result: 'stale' }
        case 'not_found':
          return { result: 'not_found' }
      }
    },

    async settleOperation(input: SettleOperationInput): Promise<boolean> {
      const { data, error } = await client.rpc('winnr_settle_operation', {
        p_organization_id: input.organizationId,
        p_operation_id: input.operationId,
        p_status: input.status,
        p_error_code: input.errorCode,
      })
      if (error) throw new WinnrConfigError('Winnr storage settlement failed')
      return data === true
    },
  }
}
