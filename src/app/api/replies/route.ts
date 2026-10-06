import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { unavailableTransport } from '@/lib/email-core/transport-gate'
import {
  type ReplyCategory,
  type ReplySentiment,
  type ReplyStatus,
} from '@/lib/replies'
import { listRepliesQuerySchema } from '@/lib/schemas'
import { validateQuery } from '@/lib/validation'
import { getRepliesWithContext, getInboxStats } from '@/lib/db/queries'

// GET /api/replies - List replies (inbox)
// Optimized: Uses single query with joins instead of multiple queries
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Get user's organization
    const { data: profile } = await supabase
      .from('users')
      .select('organization_id')
      .eq('id', user.id)
      .single() as { data: { organization_id: string } | null }

    if (!profile?.organization_id) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
    }

    // Validate query parameters
    const queryValidation = validateQuery(request, listRepliesQuerySchema)
    if (!queryValidation.success) return queryValidation.error

    const { page, limit, campaignId, mailboxId, category, sentiment, status, search } = queryValidation.data

    // Use optimized queries in parallel
    const [repliesResult, inboxStats] = await Promise.all([
      getRepliesWithContext(profile.organization_id, {
        page,
        limit,
        campaignId,
        mailboxId,
        category: category as ReplyCategory | undefined,
        sentiment: sentiment as ReplySentiment | undefined,
        status: status as ReplyStatus | undefined,
        search,
      }),
      getInboxStats(profile.organization_id),
    ])

    if (repliesResult.error) {
      throw repliesResult.error
    }

    return NextResponse.json({
      replies: (repliesResult.data || []).map(r => ({
        id: r.id,
        organizationId: r.organization_id,
        campaignId: r.campaign_id,
        leadId: r.lead_id,
        mailboxId: r.mailbox_id,
        threadId: r.thread_id,
        messageId: r.message_id,
        inReplyTo: r.in_reply_to,
        from: r.from_email,
        fromName: r.from_name,
        to: r.to_email,
        subject: r.subject,
        bodyText: r.body_text,
        bodyHtml: r.body_html,
        category: r.category,
        sentiment: r.sentiment,
        status: r.status,
        isAutoDetected: r.is_auto_detected,
        snoozedUntil: r.snoozed_until,
        receivedAt: r.received_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        // Include joined data
        lead: r.lead,
        campaign: r.campaign,
      })),
      pagination: {
        page,
        limit,
        total: repliesResult.count || 0,
        totalPages: Math.ceil((repliesResult.count || 0) / limit),
      },
      stats: {
        total: inboxStats.total,
        unread: inboxStats.unread,
        interested: inboxStats.interested,
        notInterested: inboxStats.notInterested,
        outOfOffice: inboxStats.outOfOffice,
        meetingRequests: inboxStats.meetingRequests,
        needsReply: inboxStats.needsReply,
        todayReceived: null // Not measured by this query
      },
    })
  } catch (error) {
    console.error('List replies error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// Provider ingestion is integrated through a separately verified adapter.
export async function POST(request: NextRequest) { return unavailableTransport(request) }
