import { NextResponse, type NextRequest } from 'next/server'
import { assertSameOrigin, parseJsonRequest, parseQuery, resolveAuthContext, winnrErrorResponse } from '@/app/api/winnr/_shared'
import {
  readReconciliationState,
  reconcileDispatchAttempt,
  requireReconciliationManager,
} from '@/lib/outreach/reconciliation/service'
import { reconciliationQuerySchema } from '@/lib/outreach/reconciliation/schemas'

export const maxDuration = 30

/**
 * Owner/admin operator surface for held SMTP reconciliation.
 *
 * GET lists held attempts with their persisted relay-evidence state (or a
 * single attempt when `attemptId` is supplied). POST records one already-proven
 * past effect and never contacts a provider or sends anything.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await resolveAuthContext()
    requireReconciliationManager(auth)
    const query = parseQuery(request, reconciliationQuerySchema)
    return NextResponse.json(await readReconciliationState(auth, query))
  } catch (error) {
    return winnrErrorResponse(error)
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await resolveAuthContext()
    requireReconciliationManager(auth)
    assertSameOrigin(request)
    if (Number(request.headers.get('content-length') ?? 0) > 8000) {
      return NextResponse.json({ error: { code: 'bad_request', message: 'Request too large' } }, { status: 413 })
    }
    const body = await parseJsonRequest(request)
    return NextResponse.json(await reconcileDispatchAttempt(auth, body))
  } catch (error) {
    return winnrErrorResponse(error)
  }
}
