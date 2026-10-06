import { NextResponse, type NextRequest } from 'next/server'
import {
  assertSameOrigin,
  buildWinnrDeps,
  connectBodySchema,
  disconnectBodySchema,
  parseJsonRequest,
  resolveAuthContext,
  winnrErrorResponse,
} from '../_shared'
import { connectAccount, disconnectAccount, getConnectionEnvelope } from '@/lib/winnr/server'

export async function GET(): Promise<NextResponse> {
  try {
    const ctx = await resolveAuthContext()
    return NextResponse.json(await getConnectionEnvelope(ctx, buildWinnrDeps()))
  } catch (error) {
    return winnrErrorResponse(error)
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(request)
    const ctx = await resolveAuthContext()
    const body = connectBodySchema.parse(await parseJsonRequest(request))
    return NextResponse.json(await connectAccount(ctx, buildWinnrDeps(), body))
  } catch (error) {
    return winnrErrorResponse(error)
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(request)
    const ctx = await resolveAuthContext()
    const body = disconnectBodySchema.parse(await parseJsonRequest(request))
    return NextResponse.json(await disconnectAccount(ctx, buildWinnrDeps(), body))
  } catch (error) {
    return winnrErrorResponse(error)
  }
}
