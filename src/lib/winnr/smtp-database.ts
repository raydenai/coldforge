import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { decrypt } from '@/lib/encryption'
import { getServiceRoleConfig } from './database'
import { WinnrApiError } from './server'
import { smtpCredentialSchema, smtpStatusSchema, type SmtpPersistInput } from './smtp'

type Json = null | boolean | string | number | Json[] | { [key: string]: Json | undefined }
type CredentialRow = { organization_id: string; connection_id: string; provider_mailbox_id: string; connection_version: number; email: string; account_id: string; credentials_ciphertext: string; synced_at: string }
type Table<Row> = { Row: Row; Insert: Partial<Row>; Update: Partial<Row>; Relationships: [] }
export interface WinnrSmtpDatabase {
  public: {
    Tables: { winnr_mailbox_credentials: Table<CredentialRow>; winnr_connections: Table<{ id: string; organization_id: string; version: number }> }
    Views: { [_ in never]: never }
    Functions: { winnr_sync_smtp_credentials: { Args: { p_actor: string; p_org: string; p_connection: string; p_version: number; p_mailboxes: Json }; Returns: Json } }
    Enums: { [_ in never]: never }; CompositeTypes: { [_ in never]: never }
  }
}
function storageFailure(error: { message: string }): never {
  if (error.message.includes('winnr_smtp:forbidden')) throw new WinnrApiError(403, 'forbidden', 'Only owners and admins may import SMTP credentials')
  if (error.message.includes('winnr_smtp:stale_connection')) throw new WinnrApiError(409, 'stale_connection', 'Winnr connection changed; reload before importing')
  throw new WinnrApiError(500, 'internal_error', 'Private SMTP credential storage failed')
}
export function createWinnrSmtpRepository(options: { client?: SupabaseClient<WinnrSmtpDatabase>; decrypt?: (ciphertext: string) => string; deadlineAt?: number } = {}) {
  let client: SupabaseClient<WinnrSmtpDatabase>
  if (options.client) client = options.client
  else { const { url, serviceRoleKey } = getServiceRoleConfig(); client = createClient<WinnrSmtpDatabase>(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } }) }
  // A supplied absolute deadline bounds the private credential read and the
  // non-secret mailbox status read. It is never stored, logged or used to
  // change identity/version validation.
  const deadlineSignal = (): AbortSignal | undefined => {
    if (options.deadlineAt === undefined) return undefined
    const remaining = options.deadlineAt - Date.now()
    if (remaining <= 0) return AbortSignal.abort()
    return AbortSignal.timeout(Math.max(1, Math.min(8000, remaining)))
  }
  return {
    async persist(input: SmtpPersistInput) {
      const { data, error } = await client.rpc('winnr_sync_smtp_credentials', { p_actor: input.actorId, p_org: input.organizationId, p_connection: input.connectionId, p_version: input.connectionVersion, p_mailboxes: input.mailboxes.map(mailbox => ({ ...mailbox })) })
      if (error) return storageFailure(error)
      return z.array(smtpStatusSchema).parse(data)
    },
    async status(organizationId: string, connectionId: string, connectionVersion: number) {
      // Fail closed before any storage request when the supplied budget is
      // already spent. A live budget hands the shared signal to the storage
      // client so the full HTTP read, including response-body consumption, is
      // aborted at the deadline rather than only checked before/after.
      if (options.deadlineAt !== undefined && options.deadlineAt - Date.now() <= 0) {
        throw new WinnrApiError(503, 'service_unavailable', 'Winnr storage deadline exceeded')
      }
      const query = client
        .from('winnr_mailbox_credentials')
        .select('provider_mailbox_id,email,account_id,synced_at')
        .eq('organization_id', organizationId)
        .eq('connection_id', connectionId)
        .eq('connection_version', connectionVersion)
        .order('email')
      const signal = deadlineSignal()
      const { data, error } = await (signal ? query.abortSignal(signal) : query)
      if (error) return storageFailure(error)
      return (data ?? []).map(row => smtpStatusSchema.parse({ providerMailboxId: row.provider_mailbox_id, email: row.email, accountId: row.account_id, syncedAt: row.synced_at }))
    },
    async loadCredentials(input: { organizationId: string; connectionId: string; connectionVersion: number; mailboxId: string }) {
      const connectionSignal = deadlineSignal()
      const connectionFilter = client.from('winnr_connections').select('id').eq('organization_id', input.organizationId).eq('id', input.connectionId).eq('version', input.connectionVersion)
      const connection = await (connectionSignal ? connectionFilter.abortSignal(connectionSignal).maybeSingle() : connectionFilter.maybeSingle())
      if (connection.error) return storageFailure(connection.error)
      if (!connection.data) return null
      const credentialSignal = deadlineSignal()
      const credentialFilter = client.from('winnr_mailbox_credentials').select('credentials_ciphertext,email,provider_mailbox_id').eq('organization_id', input.organizationId).eq('connection_id', input.connectionId).eq('connection_version', input.connectionVersion).eq('provider_mailbox_id', input.mailboxId)
      const { data, error } = await (credentialSignal ? credentialFilter.abortSignal(credentialSignal).maybeSingle() : credentialFilter.maybeSingle())
      if (error) return storageFailure(error)
      if (!data) return null
      try {
        const secret = smtpCredentialSchema.parse(JSON.parse((options.decrypt ?? decrypt)(data.credentials_ciphertext)))
        if (secret.providerMailboxId !== data.provider_mailbox_id || secret.fromEmail !== data.email) throw new Error()
        return secret
      } catch { throw new WinnrApiError(500, 'internal_error', 'Private SMTP credentials are unavailable') }
    },
  }
}
