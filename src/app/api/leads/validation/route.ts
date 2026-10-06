/**
 * GET /api/leads/validation
 *
 * Owner-scoped lead list with validation provenance plus provider
 * availability. The response never contains the provider key; it only reports
 * whether the integration is configured.
 */
import { NextRequest, NextResponse } from 'next/server'
import { apiLimiter, applyRateLimit } from '@/lib/rate-limit/middleware'
import { isZeroBounceConfigured, ZEROBOUNCE } from '@/lib/outreach/validation'
import { createValidationRepository } from '@/lib/outreach/validation-database'
import { resolveValidationActor, validationErrorResponse } from './_shared'

export async function GET(request: NextRequest) {
  const { limited, response } = applyRateLimit(request, apiLimiter)
  if (limited) return response!

  try {
    const actor = await resolveValidationActor(false)
    const repository = createValidationRepository()
    const [leads, outstanding] = await Promise.all([
      repository.listLeads(actor.organizationId),
      repository.listOutstandingOperations(actor.organizationId),
    ])
    const summary = repository.summarize(leads)

    const json = NextResponse.json({
      provider: { name: ZEROBOUNCE.name, configured: isZeroBounceConfigured() },
      leads,
      outstanding,
      summary,
    })
    json.headers.set('cache-control', 'no-store')
    return json
  } catch (error) {
    return validationErrorResponse(error)
  }
}
