import { assertSameOrigin, winnrErrorResponse } from '@/app/api/winnr/_shared'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { type ReplyCategory, type ReplySentiment, type ReplyStatus } from '@/lib/replies'

interface ReplyRow {
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
}

// GET /api/replies/[id] - Get single reply
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

    const { data: reply, error } = await supabase
      .from('replies')
      .select('*')
      .eq('id', id)
      .eq('organization_id', profile.organization_id)
      .single() as { data: ReplyRow | null; error: Error | null }

    if (error || !reply) {
      return NextResponse.json({ error: 'Reply not found' }, { status: 404 })
    }

    // Mark as read if unread
    if (reply.status === 'unread') {
      await supabase.from('replies')
        .update({
          status: 'read',
          updated_at: new Date().toISOString(),
        })
        .eq('id', id)

      reply.status = 'read'
    }

    // Get related lead and campaign info
    let lead = null
    let campaign = null

    if (reply.lead_id) {
      const { data } = await supabase
        .from('leads')
        .select('id, email, first_name, last_name, company, status')
        .eq('id', reply.lead_id)
        .single() as { data: Record<string, unknown> | null }
      lead = data
    }

    if (reply.campaign_id) {
      const { data } = await supabase
        .from('campaigns')
        .select('id, name, status')
        .eq('id', reply.campaign_id)
        .single() as { data: Record<string, unknown> | null }
      campaign = data
    }

    return NextResponse.json({
      reply: {
        id: reply.id,
        organizationId: reply.organization_id,
        campaignId: reply.campaign_id,
        leadId: reply.lead_id,
        mailboxId: reply.mailbox_id,
        threadId: reply.thread_id,
        messageId: reply.message_id,
        inReplyTo: reply.in_reply_to,
        from: reply.from_email,
        fromName: reply.from_name,
        to: reply.to_email,
        subject: reply.subject,
        bodyText: reply.body_text,
        bodyHtml: reply.body_html,
        category: reply.category,
        sentiment: reply.sentiment,
        status: reply.status,
        isAutoDetected: reply.is_auto_detected,
        snoozedUntil: reply.snoozed_until,
        receivedAt: reply.received_at,
        createdAt: reply.created_at,
        updatedAt: reply.updated_at,
      },
      lead,
      campaign,
    })
  } catch (error) {
    console.error('Get reply error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// PUT /api/replies/[id] - Update reply (status, category, snooze)
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

    // Verify reply belongs to organization
    const { data: existing } = await supabase
      .from('replies')
      .select('id, thread_id')
      .eq('id', id)
      .eq('organization_id', profile.organization_id)
      .single() as { data: { id: string; thread_id: string } | null }

    if (!existing) {
      return NextResponse.json({ error: 'Reply not found' }, { status: 404 })
    }

    const body = await request.json()
    const { status, category, sentiment, snoozedUntil } = body

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    }

    if (status) {
      updates.status = status
    }
    if (category) {
      updates.category = category
      updates.is_auto_detected = false // Manual override
    }
    if (sentiment) {
      updates.sentiment = sentiment
    }
    if (snoozedUntil !== undefined) {
      updates.snoozed_until = snoozedUntil
      if (snoozedUntil) {
        updates.status = 'snoozed'
      }
    }

    const { data: updatedReply, error } = await supabase.from('replies')
      .update(updates)
      .eq('id', id)
      .select()
      .single()

    if (error) {
      throw error
    }

    // Update thread category/sentiment if changed
    if (category || sentiment) {
      await supabase.from('threads')
        .update({
          ...(category && { category }),
          ...(sentiment && { sentiment }),
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.thread_id)
    }

    return NextResponse.json({ reply: updatedReply })
  } catch (error) {
    console.error('Update reply error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// DELETE /api/replies/[id] - Archive reply
export async function DELETE(
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

    // Archive (soft delete) the reply
    const { error } = await supabase.from('replies')
      .update({
        status: 'archived',
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('organization_id', profile.organization_id)

    if (error) {
      throw error
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Archive reply error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
