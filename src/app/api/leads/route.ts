import { assertSameOrigin, winnrErrorResponse } from '@/app/api/winnr/_shared'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  createLeadSchema,
  listLeadsQuerySchema,
} from '@/lib/schemas'
import {
  apiLimiter,
  writeLimiter,
  applyRateLimit,
  addRateLimitHeaders,
} from '@/lib/rate-limit/middleware'
import {
  AuthenticationError,
  BadRequestError,
  DatabaseError,
  ValidationError,
} from '@/lib/errors'
import { handleApiError } from '@/lib/errors/handler'

// List query: page/limit/listId plus a bounded email search term. `search`
// is optional; an empty or oversized value is rejected by validation.
const leadsListQuerySchema = listLeadsQuerySchema.extend({
  search: z.string().trim().min(1).max(255).optional(),
})

/** Escape PostgREST/SQL LIKE metacharacters so user text matches literally. */
function escapeIlikePattern(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
}

// GET /api/leads - List all leads
export async function GET(request: NextRequest) {
  // Apply rate limiting
  const { limited, response, result } = applyRateLimit(request, apiLimiter)
  if (limited) return response!

  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      throw new AuthenticationError()
    }

    // Get user's organization
    const { data: userData } = await supabase
      .from('users')
      .select('organization_id')
      .eq('id', user.id)
      .single() as { data: { organization_id: string } | null }

    if (!userData?.organization_id) {
      throw new BadRequestError('No organization found')
    }

    // Parse and validate query parameters. Invalid input is rejected instead
    // of silently falling back to an unbounded/unfiltered read.
    const { searchParams } = new URL(request.url)
    const queryResult = leadsListQuerySchema.safeParse({
      page: searchParams.get('page') ?? '1',
      limit: searchParams.get('limit') ?? '50',
      listId: searchParams.get('listId') ?? undefined,
      search: searchParams.get('search') ?? undefined,
    })

    if (!queryResult.success) {
      throw new ValidationError(
        queryResult.error.issues[0]?.message || 'Invalid query parameters',
        { issues: queryResult.error.issues }
      )
    }

    const { page, limit, listId, search } = queryResult.data
    const offset = (page - 1) * limit

    // Always scope to the caller's organization, then apply the optional list
    // and email filters, before any ordering/pagination is pushed to PostgREST.
    let query = supabase
      .from('leads')
      .select('*', { count: 'exact' })
      .eq('organization_id', userData.organization_id)

    if (listId) {
      query = query.eq('list_id', listId)
    }
    if (search) {
      // Treat the user's text as a literal substring; escape LIKE wildcards so
      // it can never widen the match or inject into the filter expression.
      query = query.ilike('email', `%${escapeIlikePattern(search)}%`)
    }

    query = query
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1)

    const { data: leads, error, count } = await query

    if (error) {
      throw new DatabaseError('Failed to fetch leads', { originalError: String(error) })
    }

    const total = count || 0
    const jsonResponse = NextResponse.json({
      leads,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    })
    return addRateLimitHeaders(jsonResponse, result)
  } catch (error) {
    return handleApiError(error)
  }
}

// POST /api/leads - Create a new lead
export async function POST(request: NextRequest) {
  // Apply stricter rate limiting for write operations
  const { limited, response, result } = applyRateLimit(request, writeLimiter)
  if (limited) return response!

  try { assertSameOrigin(request) } catch (error) { return winnrErrorResponse(error) }
  try {
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      throw new AuthenticationError()
    }

    const { data: userData } = await supabase
      .from('users')
      .select('organization_id')
      .eq('id', user.id)
      .single() as { data: { organization_id: string } | null }

    if (!userData?.organization_id) {
      throw new BadRequestError('No organization found')
    }

    const body = await request.json()

    // Validate request body with Zod schema
    const validationResult = createLeadSchema.safeParse(body)
    if (!validationResult.success) {
      throw new ValidationError(
        validationResult.error.issues[0]?.message || 'Invalid request body',
        { issues: validationResult.error.issues }
      )
    }

    const { email, firstName, lastName, company, title, phone, linkedinUrl, listId, customFields } = validationResult.data

    if (listId) {
      const { data: list, error: listError } = await supabase.from('lead_lists').select('id').eq('id', listId).eq('organization_id', userData.organization_id).single()
      if (listError || !list) throw new BadRequestError('List not found')
    }
    // Use admin client for INSERT to bypass RLS
    const adminClient = createAdminClient()
    const { data: lead, error } = await adminClient
      .from('leads')
      .insert({
        organization_id: userData.organization_id,
        email,
        first_name: firstName,
        last_name: lastName,
        company,
        title,
        phone,
        linkedin_url: linkedinUrl,
        list_id: listId,
        custom_fields: customFields || {},
        status: 'active',
      })
      .select()
      .single()

    if (error) {
      throw new DatabaseError('Failed to create lead', { originalError: String(error) })
    }

    const jsonResponse = NextResponse.json({ lead }, { status: 201 })
    return addRateLimitHeaders(jsonResponse, result)
  } catch (error) {
    return handleApiError(error)
  }
}
