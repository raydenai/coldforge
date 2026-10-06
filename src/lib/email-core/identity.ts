/** Narrow storage contract for tested migration025. */
import { createClient } from '@supabase/supabase-js'
interface IdentityDatabase {
  public: {
    Tables: Record<string, never>
    Views: Record<string, never>
    Functions: { bootstrap_email_identity: { Args: { p_user_id: string; p_organization_name: string | null }; Returns: { organization_id: string; role: string }[] } }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
export async function bootstrapIdentity(userId: string, organizationName: string | null) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Identity service-role storage unavailable')
  const client = createClient<IdentityDatabase>(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
  const { data, error } = await client.rpc('bootstrap_email_identity', { p_user_id: userId, p_organization_name: organizationName })
  if (error || !data?.[0]) throw new Error('Organization bootstrap failed')
  return data[0]
}
