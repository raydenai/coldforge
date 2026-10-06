import { z } from 'zod'
import { assertSameOrigin, winnrErrorResponse } from '@/app/api/winnr/_shared'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

// GET /api/leads/lists - Get all lead lists
export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Get user's organization
    const { data: userData } = await supabase
      .from('users')
      .select('organization_id')
      .eq('id', user.id)
      .single() as { data: { organization_id: string } | null }

    if (!userData?.organization_id) {
      return NextResponse.json({ error: 'No organization found' }, { status: 400 })
    }

    // Get all lists
    const { data: lists, error } = await supabase.from('lead_lists')
      .select('*, leads(count)')
      .eq('organization_id', userData.organization_id)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('Error fetching lead lists:', error)
      return NextResponse.json({ error: 'Failed to fetch lists' }, { status: 500 })
    }

    return NextResponse.json({
      lists: lists?.map(list => ({
        id: list.id,
        name: list.name,
        description: list.description,
        leadCount: list.leads[0]?.count ?? 0,
        createdAt: list.created_at,
        updatedAt: list.updated_at,
      })) || [],
    })
  } catch (error) {
    console.error('Lead lists API error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// POST /api/leads/lists - Create a new list
export async function POST(request: NextRequest) {
  try { assertSameOrigin(request) } catch (error) { return winnrErrorResponse(error) }
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const validation = z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(1000).optional() }).strict().safeParse(body)

    if (!validation.success) {
      return NextResponse.json({ error: 'Name is required' }, { status: 400 })
    }

    const { name, description } = validation.data

    // Get user's organization
    const { data: userData } = await supabase
      .from('users')
      .select('organization_id')
      .eq('id', user.id)
      .single() as { data: { organization_id: string } | null }

    if (!userData?.organization_id) {
      return NextResponse.json({ error: 'No organization found' }, { status: 400 })
    }

    // Create list using admin client to bypass RLS
    const adminClient = createAdminClient()
    const { data: list, error: createError } = await adminClient.from('lead_lists')
      .insert({
        organization_id: userData.organization_id,
        name,
        description,
        lead_count: 0,
      })
      .select()
      .single()

    if (createError) {
      console.error('Error creating list:', createError)
      return NextResponse.json({ error: 'Failed to create list' }, { status: 500 })
    }

    return NextResponse.json({
      list: {
        id: list.id,
        name: list.name,
        description: list.description,
        leadCount: list.lead_count,
        createdAt: list.created_at,
        updatedAt: list.updated_at,
      },
    }, { status: 201 })
  } catch (error) {
    console.error('Lead list create error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
