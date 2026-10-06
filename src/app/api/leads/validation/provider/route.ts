/**
 * POST /api/leads/validation/provider
 *
 * Validate exactly one owned lead through the ZeroBounce adapter.
 *
 * The durable operation row is reserved before the paid call, so a retried
 * request with the same operation UUID never triggers a second charge. Any
 * replay — including a concurrent request that finds the operation still
 * `reserved` — returns the held state and never calls the provider. Transport
 * failure and persistence failure are handled separately: a transport failure
 * is recorded as a held unknown, while a persistence failure returns a
 * reconciliation response, keeps the reservation, and never discards a paid
 * receipt or re-calls the provider.
 */
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { writeLimiter, applyRateLimit } from '@/lib/rate-limit/middleware'
import {
  isZeroBounceConfigured,
  redactValidationError,
  validationLogFields,
  type ValidationStatus,
} from '@/lib/outreach/validation'
import {
  validateWithZeroBounce,
  ZeroBounceAddressMismatchError,
  ZeroBounceInvalidResponseError,
  ZeroBounceNotConfiguredError,
  ZeroBounceResponseError,
  ZeroBounceTimeoutError,
} from '@/lib/outreach/validation-provider'
import { createValidationRepository } from '@/lib/outreach/validation-database'
import {
  assertValidationSameOrigin,
  readBoundedJson,
  resolveValidationActor,
  validationErrorResponse,
} from '../_shared'

const bodySchema = z.object({
  leadId: z.string().uuid(),
  operationId: z.string().uuid(),
})

function providerOutcome(error: unknown): string {
  if (error instanceof ZeroBounceTimeoutError) return 'timeout'
  if (error instanceof ZeroBounceAddressMismatchError) return 'address_mismatch'
  if (error instanceof ZeroBounceNotConfiguredError) return 'not_configured'
  if (error instanceof ZeroBounceInvalidResponseError) return 'invalid_response'
  if (error instanceof ZeroBounceResponseError) return 'provider_error'
  return 'unexpected_error'
}

export async function POST(request: NextRequest) {
  const { limited, response } = applyRateLimit(request, writeLimiter)
  if (limited) return response!

  try {
    assertValidationSameOrigin(request)
    const actor = await resolveValidationActor(true)
    const parsed = bodySchema.safeParse(await readBoundedJson(request))
    if (!parsed.success) {
      return NextResponse.json({ error: { code: 'bad_request', message: 'A lead and operation id are required' } }, { status: 400 })
    }
    const { leadId, operationId } = parsed.data

    if (!isZeroBounceConfigured()) {
      return NextResponse.json(
        { error: { code: 'provider_not_configured', message: 'The validation provider is not configured' } },
        { status: 503 }
      )
    }

    const repository = createValidationRepository()
    const reserved = await repository.reserveOperation({
      operationId,
      actorId: actor.userId,
      organizationId: actor.organizationId,
      leadId,
      source: 'zerobounce',
    })

    // Idempotent replay: never call the provider for an already-settled
    // operation, and never call it for an operation another request is still
    // holding (state `reserved` with replayed=true).
    if (reserved.replayed || reserved.state !== 'reserved') {
      return NextResponse.json(
        { result: reserved, replayed: true },
        { status: reserved.state === 'reserved' ? 202 : 200 }
      )
    }

    const apiKey = process.env.ZEROBOUNCE_API_KEY
    if (!apiKey || apiKey.trim().length === 0) {
      // Configuration vanished between the check and the call; fail closed
      // without charging anything.
      return NextResponse.json(
        { error: { code: 'provider_not_configured', message: 'The validation provider is not configured' } },
        { status: 503 }
      )
    }

    const log = (state: string, validationStatus: ValidationStatus | null) =>
      validationLogFields({
        operationId,
        organizationId: actor.organizationId,
        leadId,
        source: 'zerobounce',
        state,
        validationStatus,
      })

    const reconciliation = (input: {
      providerStatus: string | null
      providerEmailMatched: boolean
      reference: string | null
      checkedAt: string
      warning: string
    }) =>
      NextResponse.json(
        {
          error: {
            code: 'reconciliation_needed',
            message:
              'The validation result could not be saved. It is kept for reconciliation; retry this same operation, do not start a new attempt.',
          },
          receipt: {
            operationId,
            leadId,
            providerStatus: input.providerStatus,
            providerEmailMatched: input.providerEmailMatched,
            reference: input.reference,
            checkedAt: input.checkedAt,
          },
          warning: input.warning,
          log: log('reserved', null),
        },
        { status: 502 }
      )

    // ---- Provider call (isolated failure domain) --------------------------
    let receipt: Awaited<ReturnType<typeof validateWithZeroBounce>>
    try {
      receipt = await validateWithZeroBounce(reserved.email, { apiKey })
    } catch (providerError) {
      const outcome = providerOutcome(providerError)
      const heldAt = new Date().toISOString()
      try {
        // Record the failed attempt as a held unknown. Prior evidence, if any,
        // is preserved by the RPC, so a timeout cannot destroy a valid verdict.
        const result = await repository.finalizeProvider({
          operationId,
          actorId: actor.userId,
          organizationId: actor.organizationId,
          leadId,
          providerEmail: null,
          providerStatus: 'unknown',
          substatus: outcome,
          reference: null,
          checkedAt: heldAt,
        })
        return NextResponse.json({
          result,
          warning: redactValidationError(providerError),
          log: log(result.state, result.validationStatus),
        })
      } catch {
        return reconciliation({
          providerStatus: null,
          providerEmailMatched: false,
          reference: null,
          checkedAt: heldAt,
          warning: redactValidationError(providerError),
        })
      }
    }

    // ---- Persistence (separate failure domain) ---------------------------
    // The server receive time is trusted for `checkedAt`; the provider
    // processed_at is a reference only when it parsed to a real date.
    const reference = receipt.processedAt
    const checkedAt = receipt.receivedAt
    try {
      const result = await repository.finalizeProvider({
        operationId,
        actorId: actor.userId,
        organizationId: actor.organizationId,
        leadId,
        providerEmail: receipt.address,
        providerStatus: receipt.status,
        substatus: receipt.substatus,
        reference,
        checkedAt,
      })
      return NextResponse.json({ result, providerStatus: receipt.status })
    } catch {
      // Paid receipt could not be persisted: keep it for reconciliation and
      // never overwrite it as unknown or re-call the provider.
      return reconciliation({
        providerStatus: receipt.status,
        providerEmailMatched: true,
        reference,
        checkedAt,
        warning: redactValidationError(new Error('persistence_failed')),
      })
    }
  } catch (error) {
    return validationErrorResponse(error)
  }
}
