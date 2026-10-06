export const maxDuration = 30

import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { assertSameOrigin, parseJsonRequest, resolveAuthContext, winnrErrorResponse } from '@/app/api/winnr/_shared'
import { controlOperations, readOperationsStatus, requireOperationsManager, runManualOperationsTick } from '@/lib/outreach/operations/service'

const controlSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('enable'), expectedRevision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('disable'), expectedRevision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('pause'), expectedRevision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('resume'), expectedRevision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('stop'), expectedRevision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('resumeStop'), expectedRevision: z.number().int().positive() }).strict(),
  z.object({ action: z.literal('tick') }).strict(),
])

/** Leave headroom below the 30s platform ceiling for response serialization. */
const REQUEST_BUDGET_MS = 29_000

export async function GET() {
  const deadlineAt = Date.now() + REQUEST_BUDGET_MS
  try {
    const actor = await resolveAuthContext()
    requireOperationsManager(actor)
    return NextResponse.json(await readOperationsStatus(actor, undefined, deadlineAt))
  } catch (error) {
    return winnrErrorResponse(error)
  }
}

export async function POST(request: NextRequest) {
  // The absolute clock starts before authentication so claim, phase, grant,
  // SMTP, receipt and settlement all share one 30s request budget.
  const deadlineAt = Date.now() + REQUEST_BUDGET_MS
  try {
    const actor = await resolveAuthContext()
    requireOperationsManager(actor)
    assertSameOrigin(request)
    const input = controlSchema.parse(await parseJsonRequest(request))
    if (input.action === 'tick') {
      // Return the tick immediately. A full status/readiness refresh is a
      // separate request the UI can issue once this response is complete.
      const tick = await runManualOperationsTick(actor, undefined, deadlineAt)
      return NextResponse.json({ tick })
    }
    const control = await controlOperations(actor, input.action, input.expectedRevision, undefined, deadlineAt)
    return NextResponse.json({ control })
  } catch (error) {
    return winnrErrorResponse(error)
  }
}
