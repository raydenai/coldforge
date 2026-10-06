import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { inboxStatsQuerySchema } from '@/lib/schemas'
import { handleApiError } from '@/lib/errors/handler'
import {
  AuthenticationError,
  BadRequestError,
} from '@/lib/errors'

// Type for thread category stats
interface ThreadStatsRow {
  category: string
  status: string
  sentiment: string
}

// Type for reply status stats
interface ReplyStatsRow {
  status: string
  received_at: string
}

interface RecentReplyRow {
  received_at: string
  category: string
}

interface MailboxReplyRow {
  mailbox_id: string
  status: string
}

// GET /api/inbox/stats - Get inbox statistics
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      throw new AuthenticationError()
    }

    // Get user's organization
    const { data: profile } = await supabase
      .from('users')
      .select('organization_id')
      .eq('id', user.id)
      .single() as { data: { organization_id: string } | null }

    if (!profile?.organization_id) {
      throw new BadRequestError('Profile not found')
    }

    // Parse query parameters
    const searchParams = request.nextUrl.searchParams
    const queryResult = inboxStatsQuerySchema.safeParse({
      accountId: searchParams.get('accountId'),
      campaignId: searchParams.get('campaignId'),
      period: searchParams.get('period'),
    })

    const { accountId, campaignId, period } = queryResult.success
      ? queryResult.data
      : { accountId: undefined, campaignId: undefined, period: '7d' as const }

    // Calculate date range based on period
    const periodDays: Record<string, number> = {
      '24h': 1,
      '7d': 7,
      '30d': 30,
      '90d': 90,
    }
    const daysBack = periodDays[period] || 7
    const startDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString()

    // Build base filters
    const organizationId = profile.organization_id

    // Execute parallel queries for comprehensive stats
    const [
      threadsResult,
      repliesResult,
      unreadCountResult,
      recentRepliesResult,
      mailboxStatsResult,
    ] = await Promise.all([
      // Get all thread stats (category breakdown)
      (async () => {
        let query = supabase
          .from('threads')
          .select('category, status, sentiment')
          .eq('organization_id', organizationId)
          .neq('status', 'archived')

        if (accountId) query = query.eq('mailbox_id', accountId)
        if (campaignId) query = query.eq('campaign_id', campaignId)

        const result = await query
        return result as { data: ThreadStatsRow[] | null; error: unknown }
      })(),

      // Get all replies with status for detailed breakdown
      (async () => {
        let query = supabase
          .from('replies')
          .select('status, received_at')
          .eq('organization_id', organizationId)
          .gte('received_at', startDate)

        if (accountId) query = query.eq('mailbox_id', accountId)
        if (campaignId) query = query.eq('campaign_id', campaignId)

        const result = await query
        return result as { data: ReplyStatsRow[] | null; error: unknown }
      })(),

      // Get unread count
      (async () => {
        let query = supabase
          .from('replies')
          .select('id', { count: 'exact', head: true })
          .eq('organization_id', organizationId)
          .eq('status', 'unread')

        if (accountId) query = query.eq('mailbox_id', accountId)
        if (campaignId) query = query.eq('campaign_id', campaignId)

        return query
      })(),

      // Get recent replies (last 7 days for trend)
      (async () => {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
        let query = supabase
          .from('replies')
          .select('received_at, category')
          .eq('organization_id', organizationId)
          .gte('received_at', sevenDaysAgo)
          .order('received_at', { ascending: true })

        if (accountId) query = query.eq('mailbox_id', accountId)
        if (campaignId) query = query.eq('campaign_id', campaignId)

        const result = await query
        return result as { data: RecentReplyRow[] | null; error: unknown }
      })(),

      // Get per-mailbox stats
      (async () => {
        let query = supabase
          .from('replies')
          .select('mailbox_id, status')
          .eq('organization_id', organizationId)
          .gte('received_at', startDate)

        if (accountId) query = query.eq('mailbox_id', accountId)
        if (campaignId) query = query.eq('campaign_id', campaignId)

        const result = await query
        return result as { data: MailboxReplyRow[] | null; error: unknown }
      })(),
    ])

    // Process thread stats
    const threads = threadsResult.data || []
    const categoryBreakdown = {
      interested: 0,
      not_interested: 0,
      out_of_office: 0,
      meeting_request: 0,
      unsubscribe: 0,
      question: 0,
      bounce: 0,
      auto_reply: 0,
      other: 0,
    }
    const sentimentBreakdown = {
      positive: 0,
      negative: 0,
      neutral: 0,
      mixed: 0,
    }
    const statusBreakdown = {
      active: 0,
      resolved: 0,
    }

    for (const thread of threads) {
      const cat = thread.category as keyof typeof categoryBreakdown
      if (cat in categoryBreakdown) categoryBreakdown[cat]++

      const sent = thread.sentiment as keyof typeof sentimentBreakdown
      if (sent in sentimentBreakdown) sentimentBreakdown[sent]++

      const stat = thread.status as keyof typeof statusBreakdown
      if (stat in statusBreakdown) statusBreakdown[stat]++
    }

    // Process reply stats
    const replies = repliesResult.data || []
    const replyStatusBreakdown = {
      unread: 0,
      read: 0,
      replied: 0,
      archived: 0,
    }

    for (const reply of replies) {
      const stat = reply.status as keyof typeof replyStatusBreakdown
      if (stat in replyStatusBreakdown) replyStatusBreakdown[stat]++
    }

    // Calculate daily trend (last 7 days)
    const dailyTrend: Array<{ date: string; count: number; categories: Record<string, number> }> = []
    const recentReplies = recentRepliesResult.data || []

    const last7Days = Array.from({ length: 7 }, (_, i) => {
      const date = new Date()
      date.setDate(date.getDate() - (6 - i))
      const dateStr = date.toISOString().split('T')[0]
      return dateStr || ''
    }).filter(Boolean)

    for (const dateStr of last7Days) {
      const dayReplies = recentReplies.filter(r =>
        r.received_at.startsWith(dateStr)
      )

      const categories: Record<string, number> = {}
      for (const reply of dayReplies) {
        const replyCategory = reply.category || 'other'
        categories[replyCategory] = (categories[replyCategory] || 0) + 1
      }

      dailyTrend.push({
        date: dateStr,
        count: dayReplies.length,
        categories,
      })
    }

    // Calculate per-mailbox breakdown
    const mailboxStats: Record<string, { total: number; unread: number }> = {}
    const mailboxReplies = mailboxStatsResult.data || []

    for (const reply of mailboxReplies) {
      const mailboxId = reply.mailbox_id
      if (!mailboxId) continue

      if (!mailboxStats[mailboxId]) {
        mailboxStats[mailboxId] = { total: 0, unread: 0 }
      }
      mailboxStats[mailboxId].total++
      if (reply.status === 'unread') {
        mailboxStats[mailboxId].unread++
      }
    }

    // Calculate response metrics
    const totalReplies = replies.length
    const positiveReplies = threads.filter(t => t.sentiment === 'positive').length
    const negativeReplies = threads.filter(t => t.sentiment === 'negative').length
    const interestedThreads = categoryBreakdown.interested + categoryBreakdown.meeting_request

    const responseMetrics = {
      totalInPeriod: totalReplies,
      positiveRate: totalReplies > 0 ? Math.round((positiveReplies / threads.length) * 100) : 0,
      negativeRate: totalReplies > 0 ? Math.round((negativeReplies / threads.length) * 100) : 0,
      interestRate: threads.length > 0 ? Math.round((interestedThreads / threads.length) * 100) : 0,
    }

    return NextResponse.json({
      period,
      startDate,
      summary: {
        totalThreads: threads.length,
        totalReplies,
        unreadCount: unreadCountResult.count || 0,
        activeThreads: statusBreakdown.active,
        resolvedThreads: statusBreakdown.resolved,
      },
      categories: categoryBreakdown,
      sentiments: sentimentBreakdown,
      threadStatus: statusBreakdown,
      replyStatus: replyStatusBreakdown,
      responseMetrics,
      trend: dailyTrend,
      byMailbox: Object.entries(mailboxStats).map(([id, stats]) => ({
        mailboxId: id,
        ...stats,
      })),
    })
  } catch (error) {
    return handleApiError(error)
  }
}
