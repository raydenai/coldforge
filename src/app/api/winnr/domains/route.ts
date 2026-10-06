import { NextResponse, type NextRequest } from 'next/server'
import { buildWinnrDeps, listQuerySchema, parseQuery, resolveAuthContext, winnrErrorResponse } from '../_shared'
import { listDomains } from '@/lib/winnr/server'

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await resolveAuthContext()
    const query = parseQuery(request, listQuerySchema)
    return NextResponse.json(await listDomains(ctx, buildWinnrDeps(), query))
  } catch (error) {
    return winnrErrorResponse(error)
  }
}
