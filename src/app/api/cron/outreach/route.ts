export const maxDuration = 30

import { createHash, timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { createOperationsPorts } from '@/lib/outreach/operations/runtime'
import { runOperationsTick } from '@/lib/outreach/operations/scheduler'

/** Leave headroom below the 30s platform ceiling for response serialization. */
const REQUEST_BUDGET_MS = 29_000

/**
 * Vercel cron entry point for the bounded outreach scheduler.
 *
 * The only accepted credential is the deployed CRON_SECRET, compared in
 * constant time. No organization, actor or campaign may be supplied by the
 * caller: the service SQL resolves a current real owner/admin itself.
 */
function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest()
  const right = createHash('sha256').update(b).digest()
  return timingSafeEqual(left, right)
}

function providedSecret(request: NextRequest): string {
  const authorization = request.headers.get('authorization') ?? ''
  if (/^bearer\s+/i.test(authorization)) return authorization.replace(/^bearer\s+/i, '').trim()
  return (request.headers.get('x-cron-secret') ?? '').trim()
}

export async function GET(request: NextRequest) {
  // Start the absolute request clock before authentication so every awaited
  // storage/provider/SMTP step is budgeted from the true entry point.
  const deadlineAt = Date.now() + REQUEST_BUDGET_MS
  const secret = process.env.CRON_SECRET
  if (!secret || secret.trim() === '') {
    return NextResponse.json(
      { error: { code: 'service_unavailable', message: 'Cron secret is not configured' } },
      { status: 503 },
    )
  }
  const provided = providedSecret(request)
  if (provided === '' || !safeEqual(provided, secret)) {
    return NextResponse.json(
      { error: { code: 'unauthenticated', message: 'Invalid cron credential' } },
      { status: 401 },
    )
  }
  const result = await runOperationsTick(createOperationsPorts(), { deadlineAt })
  return NextResponse.json(result)
}
