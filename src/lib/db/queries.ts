/**
 * Optimized Database Queries
 *
 * This module contains optimized queries that avoid N+1 patterns
 * by using proper joins and aggregations in single database calls.
 */

import { createClient } from '@/lib/supabase/server'
import type { CampaignStatus, CampaignType, CampaignSettings, CampaignStats } from '@/lib/campaigns'
import type { ReplyCategory, ReplySentiment, ReplyStatus } from '@/lib/replies'

// Types for query results
export interface CampaignWithStats {
  id: string
  organization_id: string
  name: string
  status: CampaignStatus
  type: CampaignType
  settings: CampaignSettings
  stats: CampaignStats
  lead_list_ids: string[]
  mailbox_ids: string[]
  schedule_id: string | null
  created_at: string
  updated_at: string
  started_at: string | null
  paused_at: string | null
  completed_at: string | null
  // Aggregated counts
  leads_count: number
  sent_emails_count: number
  replies_count: number
}

export interface DashboardStats {
  totalCampaigns: number
  activeCampaigns: number
  totalLeads: number
  totalEmails: number
  unreadReplies: number
  emailAccounts: number
}

export interface EmailAccountWithWarmup {
  id: string
  email: string
  provider: 'google' | 'microsoft' | 'smtp'
  display_name: string | null
  daily_limit: number
  status: 'active' | 'paused' | 'error' | 'warming'
  warmup_enabled: boolean
  warmup_progress: number
  health_score: number
  sent_today: number
  created_at: string
  updated_at: string
  // Aggregated warmup stats
  warmup_emails_sent: number
  warmup_emails_opened: number
  inbox_placement_rate: number
  spam_rate: number
}

export interface ReplyWithContext {
  id: string
  organization_id: string
  campaign_id: string | null
  lead_id: string | null
  mailbox_id: string
  thread_id: string
  message_id: string
  in_reply_to: string | null
  from_email: string
  from_name: string | null
  to_email: string
  subject: string
  body_text: string
  body_html: string | null
  category: ReplyCategory
  sentiment: ReplySentiment
  status: ReplyStatus
  is_auto_detected: boolean
  snoozed_until: string | null
  received_at: string
  created_at: string
  updated_at: string
  // Joined data
  lead: {
    id: string
    email: string
    first_name: string | null
    last_name: string | null
    company: string | null
  } | null
  campaign: {
    id: string
    name: string
    status: CampaignStatus
  } | null
}

export interface InboxStats {
  total: number
  unread: number
  interested: number
  notInterested: number
  outOfOffice: number
  meetingRequests: number
  needsReply: number
}

/**
 * Get campaigns with aggregated stats in a single query
 * Avoids N+1 by using Supabase's count aggregation
 */
export async function getCampaignsWithStats(
  organizationId: string,
  options: {
    page?: number
    limit?: number
    status?: CampaignStatus[]
  } = {}
) {
  const { page = 1, limit = 20, status } = options
  const offset = (page - 1) * limit

  const supabase = await createClient()

  // Build query with counts - Supabase supports count aggregation in select
  let query = supabase
    .from('campaigns')
    .select(`
      *,
      campaign_leads:campaign_leads(count),
      sent_emails:sent_emails(count),
      replies:replies(count)
    `, { count: 'exact' })
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })

  if (status && status.length > 0) {
    query = query.in('status', status)
  }

  query = query.range(offset, offset + limit - 1)

  const { data, error, count } = await query

  if (error) {
    return { data: null, error, count: null }
  }

  // Transform the data to include counts properly
  const campaigns: CampaignWithStats[] = (data || []).map((campaign: Record<string, unknown>) => ({
    id: campaign.id as string,
    organization_id: campaign.organization_id as string,
    name: campaign.name as string,
    status: campaign.status as CampaignStatus,
    type: campaign.type as CampaignType,
    settings: campaign.settings as CampaignSettings,
    stats: campaign.stats as CampaignStats,
    lead_list_ids: campaign.lead_list_ids as string[],
    mailbox_ids: campaign.mailbox_ids as string[],
    schedule_id: campaign.schedule_id as string | null,
    created_at: campaign.created_at as string,
    updated_at: campaign.updated_at as string,
    started_at: campaign.started_at as string | null,
    paused_at: campaign.paused_at as string | null,
    completed_at: campaign.completed_at as string | null,
    // Extract counts from aggregated results
    leads_count: (campaign.campaign_leads as { count: number }[])?.[0]?.count || 0,
    sent_emails_count: (campaign.sent_emails as { count: number }[])?.[0]?.count || 0,
    replies_count: (campaign.replies as { count: number }[])?.[0]?.count || 0,
  }))

  return { data: campaigns, error: null, count }
}

/**
 * Get dashboard stats with multiple parallel counts
 * Much more efficient than sequential queries
 */
export async function getDashboardStats(organizationId: string): Promise<DashboardStats> {
  const supabase = await createClient()

  // Execute all counts in parallel
  const [
    campaignsResult,
    activeCampaignsResult,
    leadsResult,
    emailsResult,
    unreadRepliesResult,
    emailAccountsResult,
  ] = await Promise.all([
    // Total campaigns
    supabase
      .from('campaigns')
      .select('*', { count: 'exact', head: true })
      .eq('organization_id', organizationId),
    // Active campaigns
    supabase
      .from('campaigns')
      .select('*', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('status', 'active'),
    // Total leads
    supabase
      .from('leads')
      .select('*', { count: 'exact', head: true })
      .eq('organization_id', organizationId),
    // Total sent emails
    supabase
      .from('sent_emails')
      .select('*', { count: 'exact', head: true })
      .eq('organization_id', organizationId),
    // Unread replies
    supabase
      .from('replies')
      .select('*', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('status', 'unread'),
    // Email accounts
    supabase
      .from('email_accounts')
      .select('*', { count: 'exact', head: true })
      .eq('organization_id', organizationId),
  ])

  return {
    totalCampaigns: campaignsResult.count || 0,
    activeCampaigns: activeCampaignsResult.count || 0,
    totalLeads: leadsResult.count || 0,
    totalEmails: emailsResult.count || 0,
    unreadReplies: unreadRepliesResult.count || 0,
    emailAccounts: emailAccountsResult.count || 0,
  }
}

// Type for email account from query
interface EmailAccountQueryResult {
  id: string
  email: string
  display_name: string | null
  provider: string
  warmup_enabled: boolean
  warmup_progress: number | null
  health_score: number | null
  status: string
  daily_limit: number | null
  sent_today: number | null
  created_at: string
  updated_at: string
}

// Type for warmup email from query
interface WarmupEmailQueryResult {
  from_account_id: string
  status: string
}

/**
 * Get email accounts with warmup stats aggregated
 * Replaces the N+1 pattern in warmup/accounts route
 */
export async function getEmailAccountsWithWarmup(organizationId: string) {
  const supabase = await createClient()

  // Get the date for 7 days ago
  const sevenDaysAgo = new Date()
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

  // First get all email accounts
  const { data: accountsRaw, error: accountsError } = await supabase
    .from('email_accounts')
    .select('id, email, display_name, provider, warmup_enabled, warmup_progress, health_score, status, daily_limit, sent_today, created_at, updated_at')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })

  if (accountsError) {
    return { data: null, error: accountsError }
  }

  const accounts = accountsRaw as EmailAccountQueryResult[] | null

  if (!accounts || accounts.length === 0) {
    return { data: [], error: null }
  }

  // Get warmup email stats for all accounts in one query
  const accountIds = accounts.map(a => a.id)
  const { data: warmupEmailsRaw, error: warmupError } = await supabase
    .from('warmup_emails')
    .select('from_account_id, status')
    .in('from_account_id', accountIds)
    .gte('sent_at', sevenDaysAgo.toISOString())

  if (warmupError) {
    return { data: null, error: warmupError }
  }

  const warmupEmails = warmupEmailsRaw as WarmupEmailQueryResult[] | null

  // Group warmup emails by account
  const warmupByAccount = new Map<string, { total: number; opened: number }>()
  for (const email of (warmupEmails || [])) {
    const current = warmupByAccount.get(email.from_account_id) || { total: 0, opened: 0 }
    current.total++
    if (email.status === 'opened' || email.status === 'replied') {
      current.opened++
    }
    warmupByAccount.set(email.from_account_id, current)
  }

  // Combine accounts with warmup stats
  const accountsWithWarmup: EmailAccountWithWarmup[] = accounts.map(account => {
    const warmupStats = warmupByAccount.get(account.id) || { total: 0, opened: 0 }
    const inboxPlacementRate = warmupStats.total > 0
      ? Math.round((warmupStats.opened / warmupStats.total) * 100)
      : 0
    const spamRate = warmupStats.total > 0
      ? Math.max(0, 100 - inboxPlacementRate - 20)
      : 0

    return {
      id: account.id,
      email: account.email,
      provider: account.provider as 'google' | 'microsoft' | 'smtp',
      display_name: account.display_name,
      daily_limit: account.daily_limit || 50,
      status: account.status as 'active' | 'paused' | 'error' | 'warming',
      warmup_enabled: account.warmup_enabled,
      warmup_progress: account.warmup_progress || 0,
      health_score: account.health_score || 0,
      sent_today: account.sent_today || 0,
      created_at: account.created_at,
      updated_at: account.updated_at,
      warmup_emails_sent: warmupStats.total,
      warmup_emails_opened: warmupStats.opened,
      inbox_placement_rate: inboxPlacementRate,
      spam_rate: spamRate,
    }
  })

  return { data: accountsWithWarmup, error: null }
}

/**
 * Get replies with lead and campaign context in single query
 * Replaces sequential fetches after initial query
 */
export async function getRepliesWithContext(
  organizationId: string,
  options: {
    page?: number
    limit?: number
    campaignId?: string
    mailboxId?: string
    category?: ReplyCategory
    sentiment?: ReplySentiment
    status?: ReplyStatus
    search?: string
  } = {}
) {
  const { page = 1, limit = 50, campaignId, mailboxId, category, sentiment, status, search } = options
  const offset = (page - 1) * limit

  const supabase = await createClient()

  // Single query with joins
  let query = supabase
    .from('replies')
    .select(`
      *,
      lead:leads(id, email, first_name, last_name, company),
      campaign:campaigns(id, name, status)
    `, { count: 'exact' })
    .eq('organization_id', organizationId)
    .order('received_at', { ascending: false })

  // Apply filters
  if (campaignId) query = query.eq('campaign_id', campaignId)
  if (mailboxId) query = query.eq('mailbox_id', mailboxId)
  if (category) query = query.eq('category', category)
  if (sentiment) query = query.eq('sentiment', sentiment)
  if (status) query = query.eq('status', status)
  if (search) {
    query = query.or(`subject.ilike.%${search}%,body_text.ilike.%${search}%,from_email.ilike.%${search}%`)
  }

  query = query.range(offset, offset + limit - 1)

  const { data, error, count } = await query

  if (error) {
    return { data: null, error, count: null }
  }

  // Transform to typed result
  const replies: ReplyWithContext[] = (data || []).map((reply: Record<string, unknown>) => ({
    id: reply.id as string,
    organization_id: reply.organization_id as string,
    campaign_id: reply.campaign_id as string | null,
    lead_id: reply.lead_id as string | null,
    mailbox_id: reply.mailbox_id as string,
    thread_id: reply.thread_id as string,
    message_id: reply.message_id as string,
    in_reply_to: reply.in_reply_to as string | null,
    from_email: reply.from_email as string,
    from_name: reply.from_name as string | null,
    to_email: reply.to_email as string,
    subject: reply.subject as string,
    body_text: reply.body_text as string,
    body_html: reply.body_html as string | null,
    category: reply.category as ReplyCategory,
    sentiment: reply.sentiment as ReplySentiment,
    status: reply.status as ReplyStatus,
    is_auto_detected: reply.is_auto_detected as boolean,
    snoozed_until: reply.snoozed_until as string | null,
    received_at: reply.received_at as string,
    created_at: reply.created_at as string,
    updated_at: reply.updated_at as string,
    lead: reply.lead as ReplyWithContext['lead'],
    campaign: reply.campaign as ReplyWithContext['campaign'],
  }))

  return { data: replies, error: null, count }
}

// Type for thread stats query
interface ThreadStatsQueryResult {
  category: string
  status: string
}

/**
 * Get inbox stats with efficient parallel counting
 */
export async function getInboxStats(organizationId: string): Promise<InboxStats> {
  const supabase = await createClient()

  // Get all thread categories and statuses in one query
  const { data: threadsRaw } = await supabase
    .from('threads')
    .select('category, status')
    .eq('organization_id', organizationId)
    .neq('status', 'archived')

  // Get unread count
  const { count: unreadCount } = await supabase
    .from('replies')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('status', 'unread')

  // Calculate stats from threads
  const threadArray = (threadsRaw as ThreadStatsQueryResult[] | null) || []

  return {
    total: threadArray.length,
    unread: unreadCount || 0,
    interested: threadArray.filter(t => t.category === 'interested').length,
    notInterested: threadArray.filter(t => t.category === 'not_interested').length,
    outOfOffice: threadArray.filter(t => t.category === 'out_of_office').length,
    meetingRequests: threadArray.filter(t => t.category === 'meeting_request').length,
    needsReply: threadArray.filter(t => t.category === 'interested' && t.status === 'active').length,
  }
}

/**
 * Get analytics summary with aggregated counts
 * Much more efficient than loading all emails into memory
 */
export async function getAnalyticsSummary(
  organizationId: string,
  startDate: Date,
  endDate: Date,
  campaignId?: string
) {
  const supabase = await createClient()

  // Build base filter for all queries
  const baseFilter = {
    organization_id: organizationId,
    sent_at_gte: startDate.toISOString(),
    sent_at_lte: endDate.toISOString(),
    ...(campaignId ? { campaign_id: campaignId } : {}),
  }

  // Execute all counts in parallel
  const [
    totalSentResult,
    deliveredResult,
    openedResult,
    clickedResult,
    repliedResult,
    bouncedResult,
  ] = await Promise.all([
    // Total sent
    supabase
      .from('sent_emails')
      .select('*', { count: 'exact', head: true })
      .eq('organization_id', baseFilter.organization_id)
      .gte('sent_at', baseFilter.sent_at_gte)
      .lte('sent_at', baseFilter.sent_at_lte)
      .match(campaignId ? { campaign_id: campaignId } : {}),
    // Delivered (not bounced)
    supabase
      .from('sent_emails')
      .select('*', { count: 'exact', head: true })
      .eq('organization_id', baseFilter.organization_id)
      .gte('sent_at', baseFilter.sent_at_gte)
      .lte('sent_at', baseFilter.sent_at_lte)
      .neq('status', 'bounced')
      .match(campaignId ? { campaign_id: campaignId } : {}),
    // Opened
    supabase
      .from('sent_emails')
      .select('*', { count: 'exact', head: true })
      .eq('organization_id', baseFilter.organization_id)
      .gte('sent_at', baseFilter.sent_at_gte)
      .lte('sent_at', baseFilter.sent_at_lte)
      .not('opened_at', 'is', null)
      .match(campaignId ? { campaign_id: campaignId } : {}),
    // Clicked
    supabase
      .from('sent_emails')
      .select('*', { count: 'exact', head: true })
      .eq('organization_id', baseFilter.organization_id)
      .gte('sent_at', baseFilter.sent_at_gte)
      .lte('sent_at', baseFilter.sent_at_lte)
      .not('clicked_at', 'is', null)
      .match(campaignId ? { campaign_id: campaignId } : {}),
    // Replied
    supabase
      .from('sent_emails')
      .select('*', { count: 'exact', head: true })
      .eq('organization_id', baseFilter.organization_id)
      .gte('sent_at', baseFilter.sent_at_gte)
      .lte('sent_at', baseFilter.sent_at_lte)
      .not('replied_at', 'is', null)
      .match(campaignId ? { campaign_id: campaignId } : {}),
    // Bounced
    supabase
      .from('sent_emails')
      .select('*', { count: 'exact', head: true })
      .eq('organization_id', baseFilter.organization_id)
      .gte('sent_at', baseFilter.sent_at_gte)
      .lte('sent_at', baseFilter.sent_at_lte)
      .eq('status', 'bounced')
      .match(campaignId ? { campaign_id: campaignId } : {}),
  ])

  const totalSent = totalSentResult.count || 0
  const totalDelivered = deliveredResult.count || 0
  const totalOpened = openedResult.count || 0
  const totalClicked = clickedResult.count || 0
  const totalReplied = repliedResult.count || 0
  const totalBounced = bouncedResult.count || 0

  return {
    totalSent,
    totalDelivered,
    totalOpened,
    totalClicked,
    totalReplied,
    totalBounced,
    openRate: totalSent > 0 ? Math.round((totalOpened / totalSent) * 1000) / 10 : 0,
    clickRate: totalSent > 0 ? Math.round((totalClicked / totalSent) * 1000) / 10 : 0,
    replyRate: totalSent > 0 ? Math.round((totalReplied / totalSent) * 1000) / 10 : 0,
    bounceRate: totalSent > 0 ? Math.round((totalBounced / totalSent) * 1000) / 10 : 0,
    deliveryRate: totalSent > 0 ? Math.round((totalDelivered / totalSent) * 1000) / 10 : 0,
  }
}

/**
 * Get threads with latest reply and related data in single query
 * Replaces N+1 pattern in inbox route
 */
export async function getThreadsWithContext(
  organizationId: string,
  options: {
    page?: number
    limit?: number
    category?: ReplyCategory
    status?: 'active' | 'resolved' | 'archived'
    search?: string
    unreadOnly?: boolean
  } = {}
) {
  const { page = 1, limit = 50, category, status, search, unreadOnly } = options
  const offset = (page - 1) * limit

  const supabase = await createClient()

  // Single query with all joins
  let query = supabase
    .from('threads')
    .select(`
      *,
      leads:lead_id (id, email, first_name, last_name, company, title),
      campaigns:campaign_id (id, name),
      replies!replies_thread_id_fkey (id, body_text, status, received_at)
    `, { count: 'exact' })
    .eq('organization_id', organizationId)
    .order('last_message_at', { ascending: false })

  // Apply filters
  if (status) {
    query = query.eq('status', status)
  } else {
    query = query.neq('status', 'archived')
  }

  if (category) {
    query = query.eq('category', category)
  }

  if (search) {
    query = query.or(`subject.ilike.%${search}%,participant_email.ilike.%${search}%,participant_name.ilike.%${search}%`)
  }

  query = query.range(offset, offset + limit - 1)

  const { data, error, count } = await query

  if (error) {
    return { data: null, error, count: null }
  }

  // Process threads
  const processedThreads = (data || [])
    .map(thread => {
      const latestReply = thread.replies?.sort((a, b) =>
        new Date(b.received_at ?? 0).getTime() - new Date(a.received_at ?? 0).getTime()
      )[0]

      const hasUnread = thread.replies?.some(r => r.status === 'unread') || false

      // Filter if unreadOnly
      if (unreadOnly && !hasUnread) {
        return null
      }

      return {
        id: thread.id,
        organizationId: thread.organization_id,
        campaignId: thread.campaign_id,
        leadId: thread.lead_id,
        mailboxId: thread.mailbox_id,
        subject: thread.subject,
        participantEmail: thread.participant_email,
        participantName: thread.participant_name,
        messageCount: thread.message_count,
        lastMessageAt: thread.last_message_at,
        status: thread.status,
        category: thread.category,
        sentiment: thread.sentiment,
        assignedTo: thread.assigned_to,
        createdAt: thread.created_at,
        updatedAt: thread.updated_at,
        preview: latestReply?.body_text?.slice(0, 150) || '',
        hasUnread,
        lead: thread.leads ? {
          id: thread.leads.id,
          email: thread.leads.email,
          firstName: thread.leads.first_name,
          lastName: thread.leads.last_name,
          company: thread.leads.company,
          title: thread.leads.title,
        } : null,
        campaign: thread.campaigns ? {
          id: thread.campaigns.id,
          name: thread.campaigns.name,
        } : null,
      }
    })
    .filter(Boolean)

  return { data: processedThreads, error: null, count }
}
