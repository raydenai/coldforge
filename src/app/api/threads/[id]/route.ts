import { assertSameOrigin, winnrErrorResponse } from '@/app/api/winnr/_shared'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { type ReplyCategory, type ReplySentiment } from '@/lib/replies'

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

interface ThreadMessageRow {
  id: string
  thread_id: string
  direction: 'inbound' | 'outbound'
  message_id: string
  from_email: string
  from_name: string | null
  to_email: string
  subject: string
  body_text: string
  body_html: string | null
  sent_at: string
  created_at: string
}

// GET /api/threads/[id] - Get thread with all messages
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
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

    // Get thread
    const { data: thread, error: threadError } = await supabase
      .from('threads')
      .select('*')
      .eq('id', id)
      .eq('organization_id', profile.organization_id)
      .single() as { data: ThreadRow | null; error: Error | null }

    if (threadError || !thread) {
      return NextResponse.json({ error: 'Thread not found' }, { status: 404 })
    }

    // Get thread messages
    const { data: messages, error: messagesError } = await supabase
      .from('thread_messages')
      .select('*')
      .eq('thread_id', id)
      .order('sent_at', { ascending: true }) as {
        data: ThreadMessageRow[] | null
        error: Error | null
      }

    if (messagesError) {
      throw messagesError
    }

    // Get related lead if exists
    let lead = null
    if (thread.lead_id) {
      const { data } = await supabase
        .from('leads')
        .select('id, email, first_name, last_name, company, title, status')
        .eq('id', thread.lead_id)
        .single() as { data: Record<string, unknown> | null }
      lead = data
    }

    // Get related campaign if exists
    let campaign = null
    if (thread.campaign_id) {
      const { data } = await supabase
        .from('campaigns')
        .select('id, name, status')
        .eq('id', thread.campaign_id)
        .single() as { data: Record<string, unknown> | null }
      campaign = data
    }

    return NextResponse.json({
      thread: {
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
      },
      messages: messages?.map(m => ({
        id: m.id,
        threadId: m.thread_id,
        direction: m.direction,
        messageId: m.message_id,
        from: m.from_email,
        fromName: m.from_name,
        to: m.to_email,
        subject: m.subject,
        bodyText: m.body_text,
        bodyHtml: m.body_html,
        sentAt: m.sent_at,
        createdAt: m.created_at,
      })) || [],
      lead,
      campaign,
    })
  } catch (error) {
    console.error('Get thread error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// PUT /api/threads/[id] - Update thread (status, assignment)
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try { assertSameOrigin(request) } catch (error) { return winnrErrorResponse(error) }
  try {
    const { id } = await params
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

    // Verify thread belongs to organization
    const { data: existing } = await supabase
      .from('threads')
      .select('id')
      .eq('id', id)
      .eq('organization_id', profile.organization_id)
      .single() as { data: { id: string } | null }

    if (!existing) {
      return NextResponse.json({ error: 'Thread not found' }, { status: 404 })
    }

    const body = await request.json()
    const { status, assignedTo, category, sentiment } = body

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    }

    if (status) {
      updates.status = status
    }
    if (assignedTo !== undefined) {
      updates.assigned_to = assignedTo
    }
    if (category) {
      updates.category = category
    }
    if (sentiment) {
      updates.sentiment = sentiment
    }

    const { data: thread, error } = await supabase.from('threads')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      throw error
    }

    return NextResponse.json({ thread })
  } catch (error) {
    console.error('Update thread error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
