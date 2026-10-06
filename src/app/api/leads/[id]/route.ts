import { updateLeadSchema } from '@/lib/schemas'
import type { UpdateTables } from '@/types/database'
import { assertSameOrigin, winnrErrorResponse } from '@/app/api/winnr/_shared'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// GET /api/leads/[id] - Get single lead
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params

    // Get user's organization
    const { data: userData } = await supabase
      .from('users')
      .select('organization_id')
      .eq('id', user.id)
      .single() as { data: { organization_id: string } | null }

    if (!userData?.organization_id) {
      return NextResponse.json({ error: 'No organization found' }, { status: 400 })
    }

    // Get lead
    const { data: lead, error } = await supabase
      .from('leads')
      .select('*')
      .eq('id', id)
      .eq('organization_id', userData.organization_id)
      .single()

    if (error || !lead) {
      return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
    }

    return NextResponse.json({
      lead: {
        id: lead.id,
        email: lead.email,
        firstName: lead.first_name,
        lastName: lead.last_name,
        company: lead.company,
        title: lead.title,
        phone: lead.phone,
        linkedinUrl: lead.linkedin_url,
        customFields: lead.custom_fields,
        listId: lead.list_id,
        status: lead.status,
        validationStatus: lead.validation_status,
        createdAt: lead.created_at,
        updatedAt: lead.updated_at,
      },
    })
  } catch (error) {
    console.error('Lead GET error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// PATCH /api/leads/[id] - Update lead
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try { assertSameOrigin(request) } catch (error) { return winnrErrorResponse(error) }
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params
    const validation = updateLeadSchema.safeParse(await request.json())
    if (!validation.success) return NextResponse.json({ error: 'Invalid lead update' }, { status: 400 })
    const body = validation.data

    // Get user's organization
    const { data: userData } = await supabase
      .from('users')
      .select('organization_id')
      .eq('id', user.id)
      .single() as { data: { organization_id: string } | null }

    if (!userData?.organization_id) {
      return NextResponse.json({ error: 'No organization found' }, { status: 400 })
    }

    // Verify lead belongs to organization
    const { data: existing } = await supabase
      .from('leads')
      .select('id')
      .eq('id', id)
      .eq('organization_id', userData.organization_id)
      .single()

    if (!existing) {
      return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
    }

    if (body.listId) {
      const { data: list } = await supabase.from('lead_lists').select('id').eq('id', body.listId).eq('organization_id', userData.organization_id).single()
      if (!list) return NextResponse.json({ error: 'List not found' }, { status: 404 })
    }
    // Build update object
    const updates: UpdateTables<'leads'> = {
      updated_at: new Date().toISOString(),
    }

    if (body.firstName !== undefined) updates.first_name = body.firstName
    if (body.lastName !== undefined) updates.last_name = body.lastName
    if (body.company !== undefined) updates.company = body.company
    if (body.title !== undefined) updates.title = body.title
    if (body.phone !== undefined) updates.phone = body.phone
    if (body.linkedinUrl !== undefined) updates.linkedin_url = body.linkedinUrl
    if (body.customFields !== undefined) updates.custom_fields = body.customFields
    if (body.listId !== undefined) updates.list_id = body.listId
    if (body.status !== undefined) updates.status = body.status

    const { data: lead, error: updateError } = await supabase
      .from('leads')
      .update(updates)
      .eq('id', id)
      .eq('organization_id', userData.organization_id)
      .select()
      .single()

    if (updateError) {
      console.error('Error updating lead:', updateError)
      return NextResponse.json({ error: 'Failed to update lead' }, { status: 500 })
    }

    return NextResponse.json({
      lead: {
        id: lead.id,
        email: lead.email,
        firstName: lead.first_name,
        lastName: lead.last_name,
        company: lead.company,
        title: lead.title,
        phone: lead.phone,
        linkedinUrl: lead.linkedin_url,
        customFields: lead.custom_fields,
        listId: lead.list_id,
        status: lead.status,
        validationStatus: lead.validation_status,
        createdAt: lead.created_at,
        updatedAt: lead.updated_at,
      },
    })
  } catch (error) {
    console.error('Lead PATCH error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// DELETE /api/leads/[id] - Delete lead
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try { assertSameOrigin(request) } catch (error) { return winnrErrorResponse(error) }
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params

    // Get user's organization
    const { data: userData } = await supabase
      .from('users')
      .select('organization_id')
      .eq('id', user.id)
      .single() as { data: { organization_id: string } | null }

    if (!userData?.organization_id) {
      return NextResponse.json({ error: 'No organization found' }, { status: 400 })
    }

    // Verify lead exists and belongs to organization
    const { data: existing } = await supabase
      .from('leads')
      .select('id')
      .eq('id', id)
      .eq('organization_id', userData.organization_id)
      .single()

    if (!existing) {
      return NextResponse.json({ error: 'Lead not found' }, { status: 404 })
    }

    // Delete lead
    const { error: deleteError } = await supabase
      .from('leads')
      .delete()
      .eq('id', id)
      .eq('organization_id', userData.organization_id)

    if (deleteError) {
      console.error('Error deleting lead:', deleteError)
      return NextResponse.json({ error: 'Failed to delete lead' }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Lead DELETE error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
