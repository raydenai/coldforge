/** Narrow schema with tested migration023 provenance; live generated types stay unchanged. */
import { createClient } from '@supabase/supabase-js'
import type { SuppressionReason } from './suppression'
type Row = { organization_id: string; normalized_email: string; reason: SuppressionReason; source: string; notes: string | null; original_event_id: string | null; expires_at: string | null; created_at: string; updated_at: string }
export interface SuppressionDatabase {
  public: {
    Tables: { outreach_suppressions: { Row: Row; Insert: Row; Update: Partial<Row>; Relationships: [] } }
    Views: Record<string, never>
    Functions: { record_outreach_suppression: { Args: { p_organization_id: string; p_email: string; p_reason: SuppressionReason; p_source: string; p_notes: string | null; p_original_event_id: string | null; p_expires_at: string | null; p_lead_id: string | null }; Returns: boolean } }
    Enums: Record<string, never>
    CompositeTypes: Record<string, never>
  }
}
export function createSuppressionClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Suppression service-role storage unavailable')
  return createClient<SuppressionDatabase>(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}
