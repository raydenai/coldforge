import { NextResponse, type NextRequest } from 'next/server'
import { buildWinnrDeps, inboxQuerySchema, parseQuery, resolveAuthContext, winnrErrorResponse } from '../_shared'
import { listInbox } from '@/lib/winnr/server'

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const ctx = await resolveAuthContext()
    const query = parseQuery(request, inboxQuerySchema)
    return NextResponse.json(await listInbox(ctx, buildWinnrDeps(), query))
  } catch (error) {
    return winnrErrorResponse(error)
  }
}
