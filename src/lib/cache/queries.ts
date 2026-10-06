/**
 * Cached query helpers for frequently accessed data.
 * Wraps database queries with in-memory caching.
 */

import { cache, cacheKeys, TTL } from '.'
import { createClient } from '@/lib/supabase/server'

// Types for cached data
interface CampaignStats {
  sent?: number
  replied?: number
  opened?: number
  clicked?: number
  bounced?: number
}

interface Campaign {
  id: string
  name: string
  status: string
  type: string
  settings: Record<string, unknown>
  stats: CampaignStats
  lead_list_ids: string[]
  mailbox_ids: string[]
  schedule_id: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  paused_at: string | null
  completed_at: string | null
}

interface EmailAccount {
  id: string
  email: string
  provider: 'google' | 'microsoft' | 'smtp'
  display_name: string | null
  daily_limit: number
  status: 'active' | 'paused' | 'error' | 'warming'
  warmup_enabled: boolean
  health_score: number
  created_at: string
  updated_at?: string
}

interface DashboardStats {
  totalCampaigns: number
  activeCampaigns: number
  totalLeads: number
  emailAccounts: number
  warmingAccounts: number
  emailsSentToday: number
  replyRate: number
}

interface CacheResult<T> {
  data: T
  cached: boolean
}

interface CachedQueryResult<T> {
  data?: T
  error?: string
  cached: boolean
}

/**
 * Get cached dashboard stats or fetch from database.
 */
export async function getCachedDashboardStats(
  organizationId: string
): Promise<CacheResult<DashboardStats>> {
  const cacheKey = cacheKeys.dashboardStats(organizationId)

  // Check cache first
  const cached = cache.get<DashboardStats>(cacheKey)
  if (cached) {
    return { data: cached, cached: true }
  }

  // Fetch from database
  const supabase = await createClient()

  // Fetch campaigns count
  const { count: totalCampaigns } = await supabase
    .from('campaigns')
    .select('*', { count: 'exact', head: true })
    .eq('organization_id', organizationId)

  // Fetch active campaigns count
  const { count: activeCampaigns } = await supabase
    .from('campaigns')
    .select('*', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('status', 'active')

  // Fetch total leads count
  const { count: totalLeads } = await supabase
    .from('leads')
    .select('*', { count: 'exact', head: true })
    .eq('organization_id', organizationId)

  // Fetch email accounts
  const { data: accounts } = await supabase
    .from('email_accounts')
    .select('id, warmup_enabled')
    .eq('organization_id', organizationId)

  const emailAccounts = accounts?.length || 0
  const warmingAccounts = accounts?.filter(a => a.warmup_enabled).length || 0

  // Fetch emails sent today
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  const { count: emailsSentToday } = await supabase
    .from('sent_emails')
    .select('*', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .gte('sent_at', today.toISOString())

  // Calculate reply rate from recent campaigns
  const { data: recentCampaigns } = await supabase
    .from('campaigns')
    .select('stats')
    .eq('organization_id', organizationId)
    .limit(50) as { data: { stats: CampaignStats }[] | null }

  let totalSent = 0
  let totalReplied = 0
  if (recentCampaigns) {
    for (const campaign of recentCampaigns) {
      if (campaign.stats) {
        totalSent += campaign.stats.sent || 0
        totalReplied += campaign.stats.replied || 0
      }
    }
  }

  const replyRate = totalSent > 0 ? (totalReplied / totalSent) * 100 : 0

  const data: DashboardStats = {
    totalCampaigns: totalCampaigns || 0,
    activeCampaigns: activeCampaigns || 0,
    totalLeads: totalLeads || 0,
    emailAccounts,
    warmingAccounts,
    emailsSentToday: emailsSentToday || 0,
    replyRate,
  }

  // Cache for 1 minute (dashboard stats can be slightly stale)
  cache.set(cacheKey, data, TTL.MINUTE)

  return { data, cached: false }
}

/**
 * Get cached campaigns list or fetch from database.
 */
export async function getCachedCampaigns(
  organizationId: string,
  options: { page?: number; limit?: number; status?: string[] } = {}
): Promise<CachedQueryResult<{ campaigns: Campaign[]; total: number }>> {
  const { page = 1, limit = 20, status } = options
  const filterKey = JSON.stringify({ page, limit, status: status?.sort() })
  const cacheKey = cacheKeys.campaignListFiltered(organizationId, filterKey)

  // Check cache first
  const cached = cache.get<{ campaigns: Campaign[]; total: number }>(cacheKey)
  if (cached) {
    return { data: cached, cached: true }
  }

  // Fetch from database
  const supabase = await createClient()
  const offset = (page - 1) * limit

  let query = supabase
    .from('campaigns')
    .select('*', { count: 'exact' })
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })

  if (status && status.length > 0) {
    query = query.in('status', status)
  }

  query = query.range(offset, offset + limit - 1)

  const { data: campaigns, error, count } = await query as {
    data: Campaign[] | null
    error: Error | null
    count: number | null
  }

  if (error) {
    return { error: error.message, cached: false }
  }

  const result = {
    campaigns: campaigns || [],
    total: count || 0,
  }

  // Cache for 30 seconds (list data changes frequently)
  cache.set(cacheKey, result, TTL.SHORT)

  return { data: result, cached: false }
}

/**
 * Get cached email accounts list or fetch from database.
 */
export async function getCachedEmailAccounts(
  organizationId: string
): Promise<CachedQueryResult<EmailAccount[]>> {
  const cacheKey = cacheKeys.emailAccountList(organizationId)

  // Check cache first
  const cached = cache.get<EmailAccount[]>(cacheKey)
  if (cached) {
    return { data: cached, cached: true }
  }

  // Fetch from database
  const supabase = await createClient()

  const { data: accounts, error } = await supabase
    .from('email_accounts')
    .select('id, email, provider, display_name, daily_limit, status, warmup_enabled, health_score, created_at, updated_at')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false }) as { data: EmailAccount[] | null; error: Error | null }

  if (error) {
    return { error: error.message, cached: false }
  }

  // Cache for 30 seconds
  cache.set(cacheKey, accounts || [], TTL.SHORT)

  return { data: accounts || [], cached: false }
}

// ============================================
// Cache Invalidation Helpers
// ============================================

/**
 * Invalidate dashboard stats cache for an organization.
 * Call after any data change that affects dashboard stats.
 */
export function invalidateDashboardCache(organizationId: string): void {
  cache.delete(cacheKeys.dashboardStats(organizationId))
}

/**
 * Invalidate campaign list cache for an organization.
 * Call after campaign create/update/delete.
 */
export function invalidateCampaignCache(organizationId: string): void {
  // Invalidate all campaign list variants
  cache.deletePattern(`campaigns:${organizationId}`)
  // Also invalidate dashboard since it shows campaign counts
  cache.delete(cacheKeys.dashboardStats(organizationId))
}

/**
 * Invalidate email accounts cache for an organization.
 * Call after email account create/update/delete.
 */
export function invalidateEmailAccountsCache(organizationId: string): void {
  cache.delete(cacheKeys.emailAccountList(organizationId))
  // Also invalidate dashboard since it shows account counts
  cache.delete(cacheKeys.dashboardStats(organizationId))
}

/**
 * Invalidate leads cache for an organization.
 * Call after lead import/create/update/delete.
 */
export function invalidateLeadsCache(organizationId: string): void {
  cache.deletePattern(`leads:${organizationId}`)
  // Also invalidate dashboard since it shows lead counts
  cache.delete(cacheKeys.dashboardStats(organizationId))
}

/**
 * Invalidate analytics cache for an organization.
 * Call after email send or event tracking.
 */
export function invalidateAnalyticsCache(organizationId: string): void {
  cache.deletePattern(`analytics:${organizationId}`)
}

/**
 * Invalidate all caches for an organization.
 * Call after major data changes or on org settings update.
 */
export function invalidateOrgCache(organizationId: string): void {
  cache.deletePattern(`.*:${organizationId}`)
}

/**
 * Clear all cache entries. Use with caution.
 */
export function clearAllCache(): void {
  cache.clear()
}
