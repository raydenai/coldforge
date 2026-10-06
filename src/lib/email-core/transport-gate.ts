import { NextResponse, type NextRequest } from 'next/server'
import { assertSameOrigin, resolveAuthContext, winnrErrorResponse } from '@/app/api/winnr/_shared'

/** Fail closed until a durable send/ingestion transport is integrated. */
export async function unavailableTransport(request: NextRequest) {
  try {
    await resolveAuthContext()
    assertSameOrigin(request)
    return NextResponse.json({ error: { code: 'transport_not_configured', message: 'Email sending and synchronization are unavailable until the durable Winnr transport is configured.' } }, { status: 409 })
  } catch (error) { return winnrErrorResponse(error) }
}
