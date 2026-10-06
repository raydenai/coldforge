/**
 * POST /api/leads/validation/report
 *
 * Import an explicitly attributed external validation report. Every row is
 * labeled `verified_import` and requires an owner/admin attestation plus a
 * bounded report date; it can never claim a ZeroBounce receipt. Rows are
 * bounded and never trigger a paid provider call.
 */
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { writeLimiter, applyRateLimit } from '@/lib/rate-limit/middleware'
import { IMPORT_MAX_ROWS, VALIDATION_STATUSES } from '@/lib/outreach/validation'
import { createValidationRepository, ValidationRepositoryError } from '@/lib/outreach/validation-database'
import {
  assertValidationSameOrigin,
  readBoundedJson,
  resolveValidationActor,
  validationErrorResponse,
} from '../_shared'

const MAX_REPORT_AGE_MS = 30 * 24 * 60 * 60 * 1000
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000

const rowSchema = z.object({
  leadId: z.string().uuid(),
  operationId: z.string().uuid(),
  status: z.enum(['valid', 'invalid', 'risky', 'unknown']),
  reference: z.string().trim().min(1).max(300).optional(),
})

const bodySchema = z
  .object({
    source: z.string().trim().min(1).max(100),
    reportedAt: z.string().datetime(),
    attested: z.literal(true),
    rows: z.array(rowSchema).min(1).max(IMPORT_MAX_ROWS),
  })
  .superRefine((value, ctx) => {
    const reportedAt = Date.parse(value.reportedAt)
    if (Number.isNaN(reportedAt)) {
      ctx.addIssue({ code: 'custom', message: 'Invalid report date' })
      return
    }
    const now = Date.now()
    if (reportedAt > now + MAX_FUTURE_SKEW_MS) ctx.addIssue({ code: 'custom', message: 'Report date is in the future' })
    if (reportedAt < now - MAX_REPORT_AGE_MS) ctx.addIssue({ code: 'custom', message: 'Report date is too old' })
  })

export async function POST(request: NextRequest) {
  const { limited, response } = applyRateLimit(request, writeLimiter)
  if (limited) return response!

  try {
    assertValidationSameOrigin(request)
    const actor = await resolveValidationActor(true)
    const parsed = bodySchema.safeParse(await readBoundedJson(request))
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: {
            code: 'bad_request',
            message:
              parsed.error.issues[0]?.message ??
              'A source, report date, explicit attestation, and at least one row are required',
          },
        },
        { status: 400 }
      )
    }
    const { source, reportedAt, rows } = parsed.data
    const repository = createValidationRepository()

    const results: Array<{ operationId: string; ok: boolean; validationStatus?: string | null; error?: string }> = []
    for (const row of rows) {
      try {
        const result = await repository.importReport({
          operationId: row.operationId,
          actorId: actor.userId,
          organizationId: actor.organizationId,
          leadId: row.leadId,
          status: row.status,
          source,
          reference: row.reference ?? source,
          reportedAt,
          attested: true,
        })
        results.push({ operationId: row.operationId, ok: true, validationStatus: result.validationStatus })
      } catch (error) {
        if (error instanceof ValidationRepositoryError) {
          results.push({ operationId: row.operationId, ok: false, error: error.code.replace('lead_validation:', '') })
        } else {
          throw error
        }
      }
    }

    const summary = (VALIDATION_STATUSES as readonly string[]).map((status) => ({
      status,
      count: results.filter((row) => row.validationStatus === status).length,
    }))
    return NextResponse.json({ imported: results.filter((row) => row.ok).length, failed: results.filter((row) => !row.ok).length, results, summary })
  } catch (error) {
    return validationErrorResponse(error)
  }
}
