import { createClient as createSupabaseClient, SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

export type TypedSupabaseClient = SupabaseClient<Database>

// Admin client for server-side operations that don't need user context
// Uses service role key for full access (use carefully)
let adminClient: SupabaseClient<Database> | null = null

export function createAdminClient(): SupabaseClient<Database> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error('Supabase service-role storage is not configured')
  }
  if (adminClient) return adminClient
  adminClient = createSupabaseClient<Database>(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  })

  return adminClient
}

// Simple client for operations that don't need auth context
export function createSimpleClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Missing Supabase environment variables')
  }

  return createSupabaseClient<Database>(supabaseUrl, supabaseKey)
}
