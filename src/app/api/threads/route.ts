import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { type ReplyCategory, type ReplySentiment } from '@/lib/replies'
import { listThreadsQuerySchema } from '@/lib/schemas'
import { validateQuery } from '@/lib/validation'

interface ThreadRow {
  id: string
  organization_id: string
  campaign_id: string | null
  lead_id: string | null
  mailbox_id: string
  subject: string
  participant_email: string
  participant_name: string | null
  message_count: number
  last_message_at: string
  status: 'active' | 'resolved' | 'archived'
  category: ReplyCategory
  sentiment: ReplySentiment
  assigned_to: string | null
  created_at: string
  updated_at: string
}

// GET /api/threads - List conversation threads
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
    const queryValidation = validateQuery(request, listThreadsQuerySchema)
    if (!queryValidation.success) return queryValidation.error

    const { page, limit, status, category, campaignId, search } = queryValidation.data

    // Build query
    let query = supabase
      .from('threads')
      .select('*', { count: 'exact' })
      .eq('organization_id', profile.organization_id)
      .order('last_message_at', { ascending: false })

    // Apply filters
    if (status) {
      query = query.eq('status', status)
    }
    if (category) {
      query = query.eq('category', category)
    }
    if (campaignId) {
      query = query.eq('campaign_id', campaignId)
    }
    if (search) {
      query = query.or(`subject.ilike.%${search}%,participant_email.ilike.%${search}%`)
    }

    // Pagination
    const from = (page - 1) * limit
    const to = from + limit - 1
    query = query.range(from, to)

    const { data: threads, error, count } = await query as {
      data: ThreadRow[] | null
      error: Error | null
      count: number | null
    }

    if (error) {
      throw error
    }

    return NextResponse.json({
      threads: threads?.map(t => ({
        id: t.id,
        organizationId: t.organization_id,
        campaignId: t.campaign_id,
        leadId: t.lead_id,
        mailboxId: t.mailbox_id,
        subject: t.subject,
        participantEmail: t.participant_email,
        participantName: t.participant_name,
        messageCount: t.message_count,
        lastMessageAt: t.last_message_at,
        status: t.status,
        category: t.category,
        sentiment: t.sentiment,
        assignedTo: t.assigned_to,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
      })) || [],
      pagination: {
        page,
        limit,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limit),
      },
    })
  } catch (error) {
    console.error('List threads error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
