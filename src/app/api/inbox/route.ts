import { assertSameOrigin, winnrErrorResponse } from '@/app/api/winnr/_shared'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { type ReplyCategory } from '@/lib/replies'
import {
  listInboxQuerySchema,
  inboxBulkActionSchema,
} from '@/lib/schemas'
import { getThreadsWithContext, getInboxStats } from '@/lib/db/queries'

// GET /api/inbox - Get inbox threads with latest reply preview
// Optimized: Uses consolidated query with proper joins
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

    // Parse and validate query parameters
    const searchParams = request.nextUrl.searchParams
    const queryResult = listInboxQuerySchema.safeParse({
      page: searchParams.get('page'),
      limit: searchParams.get('limit'),
      category: searchParams.get('category'),
      status: searchParams.get('status'),
      search: searchParams.get('search'),
      unreadOnly: searchParams.get('unreadOnly'),
    })

    const { page, limit, category, status, search, unreadOnly } = queryResult.success
      ? queryResult.data
      : { page: 1, limit: 50, category: undefined, status: undefined, search: undefined, unreadOnly: false }

    // Use optimized query with all joins in single call
    const [threadsResult, stats] = await Promise.all([
      getThreadsWithContext(profile.organization_id, {
        page,
        limit,
        category: category as ReplyCategory | undefined,
        status: status as 'active' | 'resolved' | 'archived' | undefined,
        search,
        unreadOnly,
      }),
      getInboxStats(profile.organization_id),
    ])

    if (threadsResult.error) {
      throw threadsResult.error
    }

    return NextResponse.json({
      threads: threadsResult.data || [],
      pagination: {
        page,
        limit,
        total: threadsResult.count || 0,
        totalPages: Math.ceil((threadsResult.count || 0) / limit),
      },
      stats: {
        total: stats.total,
        unread: stats.unread,
        interested: stats.interested,
        notInterested: stats.notInterested,
        outOfOffice: stats.outOfOffice,
        meetingRequest: stats.meetingRequests,
        unsubscribe: 0, // Not tracked in current stats
        question: 0, // Not tracked in current stats
      },
    })
  } catch (error) {
    console.error('List inbox error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// POST /api/inbox - Bulk actions on threads
export async function POST(request: NextRequest) {
  try { assertSameOrigin(request) } catch (error) { return winnrErrorResponse(error) }
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

    const body = await request.json()

    // Validate request body with Zod schema
    const validationResult = inboxBulkActionSchema.safeParse(body)
    if (!validationResult.success) {
      const errorMessage = validationResult.error.issues[0]?.message || 'Invalid request body'
      return NextResponse.json({ error: errorMessage }, { status: 400 })
    }

    const { action, threadIds, replyIds } = validationResult.data

    const now = new Date().toISOString()

    switch (action) {
      case 'mark_read':
        if (replyIds?.length) {
          await supabase
            .from('replies')
            .update({ status: 'read', updated_at: now })
            .in('id', replyIds)
            .eq('organization_id', profile.organization_id)
        }
        if (threadIds?.length) {
          // Mark all replies in threads as read
          await supabase
            .from('replies')
            .update({ status: 'read', updated_at: now })
            .in('thread_id', threadIds)
            .eq('organization_id', profile.organization_id)
            .eq('status', 'unread')
        }
        break

      case 'mark_unread':
        if (replyIds?.length) {
          await supabase
            .from('replies')
            .update({ status: 'unread', updated_at: now })
            .in('id', replyIds)
            .eq('organization_id', profile.organization_id)
        }
        break

      case 'archive':
        if (threadIds?.length) {
          await supabase
            .from('threads')
            .update({ status: 'archived', updated_at: now })
            .in('id', threadIds)
            .eq('organization_id', profile.organization_id)

          // Also archive all replies
          await supabase
            .from('replies')
            .update({ status: 'archived', updated_at: now })
            .in('thread_id', threadIds)
            .eq('organization_id', profile.organization_id)
        }
        break

      case 'resolve':
        if (threadIds?.length) {
          await supabase
            .from('threads')
            .update({ status: 'resolved', updated_at: now })
            .in('id', threadIds)
            .eq('organization_id', profile.organization_id)
        }
        break

      case 'unarchive':
        if (threadIds?.length) {
          await supabase
            .from('threads')
            .update({ status: 'active', updated_at: now })
            .in('id', threadIds)
            .eq('organization_id', profile.organization_id)
        }
        break
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Bulk action error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
