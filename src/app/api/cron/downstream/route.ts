export const maxDuration = 30

import { createHash, timingSafeEqual } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { createDownstreamWorkerDeps } from '@/lib/outreach/downstream/runtime'
import { runDownstreamTick } from '@/lib/outreach/downstream/scheduler'

const REQUEST_BUDGET_MS = 29_000

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

/**
 * Vercel cron entry point for the bounded downstream scheduler. Same
 * constant-time CRON_SECRET pattern as the email operations cron; the tenant
 * and actor are resolved server-side by the service RPC, never supplied here.
 */
export async function GET(request: NextRequest) {
  const deadlineAt = Date.now() + REQUEST_BUDGET_MS
  const secret = process.env.CRON_SECRET
  if (!secret || secret.trim() === '') {
    return NextResponse.json({ error: { code: 'service_unavailable', message: 'Cron secret is not configured' } }, { status: 503 })
  }
  const provided = providedSecret(request)
  if (provided === '' || !safeEqual(provided, secret)) {
    return NextResponse.json({ error: { code: 'unauthenticated', message: 'Invalid cron credential' } }, { status: 401 })
  }
  const result = await runDownstreamTick(createDownstreamWorkerDeps(), { deadlineAt })
  return NextResponse.json(result)
}
