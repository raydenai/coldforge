/**
 * HTTP plumbing for the lead validation routes.
 *
 * Membership and role come from the authenticated cookie session; only owner
 * or admin may mutate validation. Every mutation is same-origin. Responses use
 * a small sanitized envelope and never echo a provider key or recipient data
 * beyond the selected lead the caller already owns.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ValidationRepositoryError } from '@/lib/outreach/validation-database'
import { MAX_JSON_BYTES } from '@/lib/outreach/validation'

export class ValidationApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'ValidationApiError'
  }
}

export interface ValidationActor {
  userId: string
  organizationId: string
  role: 'owner' | 'admin' | 'member'
}

export async function resolveValidationActor(requirePrivileged = true): Promise<ValidationActor> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new ValidationApiError(401, 'unauthenticated', 'Authentication required')

  const { data } = await supabase.from('users').select('organization_id, role').eq('id', user.id).single()
  const row = (data ?? null) as { organization_id: string | null; role: string | null } | null
  if (!row?.organization_id || !row.role) {
    throw new ValidationApiError(403, 'forbidden', 'An organization membership is required')
  }
  if (requirePrivileged && row.role !== 'owner' && row.role !== 'admin') {
    throw new ValidationApiError(403, 'forbidden', 'Only an owner or admin can change validation')
  }
  return { userId: user.id, organizationId: row.organization_id, role: row.role as ValidationActor['role'] }
}

export function assertValidationSameOrigin(request: NextRequest): void {
  const origin = request.headers.get('origin')
  if (!origin) throw new ValidationApiError(403, 'forbidden', 'A same-origin request is required')
  const allowed = new Set<string>([request.nextUrl.origin])
  const configured = process.env.NEXT_PUBLIC_APP_URL
  if (configured) {
    try {
      allowed.add(new URL(configured).origin)
    } catch {
      // Ignore a malformed optional configuration value.
    }
  }
  if (!allowed.has(origin)) throw new ValidationApiError(403, 'forbidden', 'A same-origin request is required')
}

export function validationErrorResponse(error: unknown): NextResponse {
  if (error instanceof ValidationApiError) {
    return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: error.status })
  }
  if (error instanceof ValidationRepositoryError) {
    const code = error.code.replace('lead_validation:', '')
    if (code.includes('forbidden')) {
      return NextResponse.json(
        { error: { code: 'forbidden', message: 'Only an owner or admin can change validation' } },
        { status: 403 }
      )
    }
    if (code === 'lead_not_found') {
      return NextResponse.json({ error: { code, message: 'Lead not found' } }, { status: 404 })
    }
    if (code === 'operation_conflict' || code === 'email_changed') {
      return NextResponse.json(
        { error: { code, message: 'This operation no longer matches the lead; start a new validation.' } },
        { status: 409 }
      )
    }
    if (code === 'unresolved_operation') {
      return NextResponse.json(
        {
          error: {
            code,
            message: 'An earlier validation attempt for this address is still unresolved; resume it instead of starting a new one.',
          },
        },
        { status: 409 }
      )
    }
    if (code === 'invalid_input' || code === 'invalid_source' || code === 'invalid_email' || code === 'invalid_status' || code === 'invalid_report' || code === 'stale_report' || code === 'attestation_required') {
      return NextResponse.json({ error: { code, message: 'The validation request was rejected.' } }, { status: 400 })
    }
    return NextResponse.json(
      { error: { code: 'validation_failed', message: 'Validation could not be completed' } },
      { status: 502 }
    )
  }
  return NextResponse.json({ error: { code: 'internal_error', message: 'Internal server error' } }, { status: 500 })
}

/**
 * Read and parse a JSON body, but bound the raw bytes BEFORE parsing so an
 * oversized payload cannot be materialized and parsed in memory.
 */
export async function readBoundedJson(request: NextRequest): Promise<unknown> {
  let text: string
  try {
    text = await request.text()
  } catch {
    throw new ValidationApiError(400, 'bad_request', 'Invalid JSON request')
  }
  if (text.length > MAX_JSON_BYTES) {
    throw new ValidationApiError(413, 'payload_too_large', 'The request body is too large')
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new ValidationApiError(400, 'bad_request', 'Invalid JSON request')
  }
}
