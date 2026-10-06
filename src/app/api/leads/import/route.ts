import { assertSameOrigin, winnrErrorResponse } from '@/app/api/winnr/_shared'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { invalidateLeadsCache } from '@/lib/cache/queries'

interface LeadImportRow {
  email: string
  firstName?: string
  lastName?: string
  company?: string
  title?: string
  phone?: string
  linkedinUrl?: string
  customFields?: Record<string, string>
}

/**
 * Build an update for an existing lead from the explicitly supplied import
 * fields only. Omitted fields are left untouched; an explicitly supplied empty
 * value clears that field. List membership and custom metadata are only written
 * when the caller supplies them.
 */
function buildExistingLeadUpdate(lead: LeadImportRow, listId?: string): Record<string, unknown> {
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  const textFields: Array<[keyof LeadImportRow, string]> = [
    ['firstName', 'first_name'],
    ['lastName', 'last_name'],
    ['company', 'company'],
    ['title', 'title'],
    ['phone', 'phone'],
    ['linkedinUrl', 'linkedin_url'],
  ]
  for (const [input, column] of textFields) {
    if (!Object.prototype.hasOwnProperty.call(lead, input)) continue
    const value = lead[input]
    if (typeof value !== 'string') continue
    update[column] = value ? value : null
  }
  if (Object.prototype.hasOwnProperty.call(lead, 'customFields')) {
    const value = lead.customFields
    update.custom_fields = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  }
  if (listId) update.list_id = listId
  return update
}

// POST /api/leads/import - Bulk import leads from array
export async function POST(request: NextRequest) {
  try { assertSameOrigin(request) } catch (error) { return winnrErrorResponse(error) }
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

    const body = await request.json()
    const { leads, listId, skipDuplicates = true, updateExisting = false } = body as {
      leads: LeadImportRow[]
      listId?: string
      skipDuplicates?: boolean
      updateExisting?: boolean
    }

    if (!leads || !Array.isArray(leads) || leads.length === 0) {
      return NextResponse.json({ error: 'Leads array is required' }, { status: 400 })
    }

    // Validate all leads have email
    const invalidLeads = leads.filter(lead => !lead.email)
    if (invalidLeads.length > 0) {
      return NextResponse.json({
        error: `${invalidLeads.length} leads missing email address`
      }, { status: 400 })
    }

    // If listId provided, verify it exists and belongs to org
    if (listId) {
      const { data: list } = await supabase
        .from('lead_lists')
        .select('id')
        .eq('id', listId)
        .eq('organization_id', userData.organization_id)
        .single()

      if (!list) {
        return NextResponse.json({ error: 'List not found' }, { status: 404 })
      }
    }

    let imported = 0
    let skipped = 0
    let updated = 0
    const errors: string[] = []

    // Use admin client for INSERT/UPDATE operations to bypass RLS
    const adminClient = createAdminClient()

    // Process in batches of 100
    const batchSize = 100
    for (let i = 0; i < leads.length; i += batchSize) {
      const batch = leads.slice(i, i + batchSize)

      for (const lead of batch) {
        try {
          // Check for existing lead by email (use regular client for reads)
          const { data: existing } = await supabase
            .from('leads')
            .select('id')
            .eq('organization_id', userData.organization_id)
            .eq('email', lead.email.toLowerCase().trim())
            .single()

          if (existing) {
            if (skipDuplicates && !updateExisting) {
              skipped++
              continue
            }

            if (updateExisting) {
              // Update existing lead using admin client, preserving omitted fields.
              const { error: updateError } = await adminClient
                .from('leads')
                .update(buildExistingLeadUpdate(lead, listId))
                .eq('id', existing.id)

              if (updateError) {
                errors.push(`Failed to update ${lead.email}: ${updateError.message}`)
              } else {
                updated++
              }
              continue
            }
          }

          // Insert new lead using admin client
          const { error: insertError } = await adminClient
            .from('leads')
            .insert({
              organization_id: userData.organization_id,
              email: lead.email.toLowerCase().trim(),
              first_name: lead.firstName || null,
              last_name: lead.lastName || null,
              company: lead.company || null,
              title: lead.title || null,
              phone: lead.phone || null,
              linkedin_url: lead.linkedinUrl || null,
              custom_fields: lead.customFields || {},
              list_id: listId || null,
              status: 'active',
            })

          if (insertError) {
            errors.push(`Failed to insert ${lead.email}: ${insertError.message}`)
          } else {
            imported++
          }
        } catch (err) {
          errors.push(`Error processing ${lead.email}: ${err}`)
        }
      }
    }

    // Update list lead count if listId provided
    if (listId) {
      const { count } = await supabase
        .from('leads')
        .select('*', { count: 'exact', head: true })
        .eq('organization_id', userData.organization_id)
        .eq('list_id', listId)

      // Use admin client for update to bypass RLS
      await adminClient
        .from('lead_lists')
        .update({
          lead_count: count || 0,
          updated_at: new Date().toISOString(),
        })
        .eq('id', listId)
    }

    // Invalidate leads cache after import
    invalidateLeadsCache(userData.organization_id)

    return NextResponse.json({
      success: errors.length === 0,
      totalRows: leads.length,
      imported,
      skipped,
      updated,
      errors: errors.slice(0, 100), // Limit errors in response
    })
  } catch (error) {
    console.error('Lead import error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
