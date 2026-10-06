import { NextResponse, type NextRequest } from 'next/server'
import {
  assertSameOrigin,
  buildWinnrDeps,
  parseQuery,
  parseJsonRequest,
  resolveAuthContext,
  warmingBodySchema,
  warmingQuerySchema,
  winnrErrorResponse,
} from '../_shared'
import { listWarming, mutateWarming } from '@/lib/winnr/server'

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await resolveAuthContext()
    const query = parseQuery(request, warmingQuerySchema)
    return NextResponse.json(await listWarming(ctx, buildWinnrDeps(), query))
  } catch (error) {
    return winnrErrorResponse(error)
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(request)
    const ctx = await resolveAuthContext()
    const body = warmingBodySchema.parse(await parseJsonRequest(request))
    return NextResponse.json(await mutateWarming(ctx, buildWinnrDeps(), body))
  } catch (error) {
    return winnrErrorResponse(error)
  }
}
