/**
 * Shared HTTP plumbing for the Winnr routes.
 *
 * Membership is resolved from the authenticated cookie session before the
 * service-role repository is constructed. Inputs are parsed with Zod at the
 * trust boundary, errors are always the universal sanitized envelope, and
 * mutations require a same-origin request.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { WinnrClient } from '@/lib/winnr/client'
import {
  WinnrApiError,
  type WinnrAuthContext,
  type WinnrErrorBody,
  type WinnrServiceDeps,
} from '@/lib/winnr/server'
import { WinnrConfigError, createServiceRoleRepository } from '@/lib/winnr/database'

const memberSchema = z.object({
  organization_id: z.string().uuid().nullable(),
  role: z.enum(['owner', 'admin', 'member']),
})

export async function resolveAuthContext(): Promise<WinnrAuthContext> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    throw new WinnrApiError(401, 'unauthenticated', 'Authentication required')
  }

  const { data } = await supabase.from('users').select('organization_id, role').eq('id', user.id).single()
  const parsed = memberSchema.safeParse(data)
  if (!parsed.success || !parsed.data.organization_id) {
    throw new WinnrApiError(403, 'forbidden', 'An organization membership is required')
  }

  return {
    userId: user.id,
    organizationId: parsed.data.organization_id,
    role: parsed.data.role,
  }
}

export function buildWinnrDeps(options: { signal?: AbortSignal; deadlineAt?: number } = {}): WinnrServiceDeps {
  // The optional absolute deadline bounds the service-repository
  // connection/token read (inside `requireConnection`), not just the provider
  // HTTP read; with no deadline the storage read is unchanged.
  const bounded = options.signal !== undefined || options.deadlineAt !== undefined
  return {
    repository: bounded
      ? createServiceRoleRepository({
          ...(options.deadlineAt !== undefined ? { deadlineAt: options.deadlineAt } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        })
      : createServiceRoleRepository(),
    createProvider: (token) => WinnrClient({ token, ...(options.signal ? { signal: options.signal } : {}) }),
  }
}

export function assertSameOrigin(request: NextRequest): void {
  const origin = request.headers.get('origin')
  if (!origin) {
    throw new WinnrApiError(403, 'forbidden', 'A same-origin request is required')
  }
  const allowed = new Set<string>([request.nextUrl.origin])
  const configured = process.env.NEXT_PUBLIC_APP_URL
  if (configured) {
    try {
      allowed.add(new URL(configured).origin)
    } catch {
      // Ignore a malformed optional configuration value.
    }
  }
  if (!allowed.has(origin)) {
    throw new WinnrApiError(403, 'forbidden', 'A same-origin request is required')
  }
}

export function winnrErrorResponse(error: unknown): NextResponse {
  if (error instanceof WinnrApiError) {
    return NextResponse.json(error.toBody(), { status: error.status })
  }
  if (error instanceof WinnrConfigError) {
    const body: WinnrErrorBody = {
      error: { code: 'service_unavailable', message: 'Winnr storage is not configured' },
    }
    return NextResponse.json(body, { status: 503 })
  }
  if (error instanceof z.ZodError) {
    const body: WinnrErrorBody = { error: { code: 'bad_request', message: 'Invalid request' } }
    return NextResponse.json(body, { status: 400 })
  }
  const body: WinnrErrorBody = { error: { code: 'internal_error', message: 'Internal server error' } }
  return NextResponse.json(body, { status: 500 })
}

export function parseQuery<T>(request: NextRequest, schema: z.ZodType<T>): T {
  const raw: Record<string, string> = {}
  request.nextUrl.searchParams.forEach((value, key) => {
    raw[key] = value
  })
  return schema.parse(raw)
}

export async function parseJsonRequest(request: NextRequest): Promise<unknown> {
  try {
    return await request.json()
  } catch (error) {
    if (error instanceof SyntaxError) throw new WinnrApiError(400, 'bad_request', 'Invalid JSON request')
    throw error
  }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const connectBodySchema = z.object({
  token: z.string().min(1).max(4096).regex(/^\S+$/, 'Invalid token'),
  expectedConnectionId: z.string().uuid().nullish().transform((v) => v ?? null),
  expectedVersion: z.number().int().positive().nullish().transform((v) => v ?? null),
})

export const disconnectBodySchema = z.object({
  expectedConnectionId: z.string().uuid(),
  expectedVersion: z.number().int().positive(),
})

export const warmingBodySchema = z.object({
  action: z.enum(['enable', 'pause', 'resume']),
  connectionId: z.string().min(1).max(200),
  connectionVersion: z.number().int().positive(),
  operationId: z.string().uuid(),
  mailboxIds: z.array(z.string().min(1).max(200)).min(1).max(1),
  confirmPaid: z.boolean().optional(),
})

const cursorQuerySchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
})

export const inboxQuerySchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  mailboxId: z.string().min(1).max(200).optional(),
})

export const warmingQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).optional(),
  perPage: z.coerce.number().int().min(1).max(500).optional(),
})

export const listQuerySchema = cursorQuerySchema
