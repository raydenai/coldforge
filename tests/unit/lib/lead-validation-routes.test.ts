/**
 * Fake-route boundary tests for the paid provider validation endpoint.
 *
 * These exercise the request/response contract without network or a real
 * provider: a concurrent in-flight replay and a persistence failure must each
 * result in exactly one provider call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const boundary = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  select: vi.fn(),
  eq: vi.fn(),
  single: vi.fn(),
  reserve: vi.fn(),
  finalize: vi.fn(),
  validate: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: boundary.getUser }, from: boundary.from }),
}))
vi.mock('@/lib/rate-limit/middleware', () => ({
  applyRateLimit: () => ({ limited: false, response: undefined }),
  writeLimiter: {},
  apiLimiter: {},
}))
vi.mock('@/lib/outreach/validation-database', async (original) => {
  const actual = await original<typeof import('@/lib/outreach/validation-database')>()
  return {
    ...actual,
    createValidationRepository: () => ({ reserveOperation: boundary.reserve, finalizeProvider: boundary.finalize }),
  }
})
vi.mock('@/lib/outreach/validation-provider', async (original) => {
  const actual = await original<typeof import('@/lib/outreach/validation-provider')>()
  return { ...actual, validateWithZeroBounce: boundary.validate }
})

import { POST } from '@/app/api/leads/validation/provider/route'
import { ZeroBounceTimeoutError } from '@/lib/outreach/validation-provider'
import { ValidationRepositoryError } from '@/lib/outreach/validation-database'

const org = '11111111-1111-4111-8111-111111111111'
const user = '22222222-2222-4222-8222-222222222222'
const leadId = '33333333-3333-4333-8333-333333333333'
const operationId = '44444444-4444-4444-8444-444444444444'

function request() {
  return new NextRequest('https://app.example/api/leads/validation/provider', {
    method: 'POST',
    headers: { origin: 'https://app.example', 'content-type': 'application/json' },
    body: JSON.stringify({ leadId, operationId }),
  })
}

const receipt = {
  provider: 'zerobounce' as const,
  address: 'person@example.com',
  status: 'valid' as const,
  substatus: null,
  processedAt: '2026-10-05T12:00:00.000Z',
  receivedAt: '2026-10-06T01:00:00.000Z',
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('ZEROBOUNCE_API_KEY', 'test-key')
  boundary.getUser.mockResolvedValue({ data: { user: { id: user } }, error: null })
  boundary.from.mockReturnValue({ select: boundary.select })
  boundary.select.mockReturnValue({ eq: boundary.eq })
  boundary.eq.mockReturnValue({ single: boundary.single })
  boundary.single.mockResolvedValue({ data: { organization_id: org, role: 'owner' } })
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('provider route paid-operation boundary', () => {
  it('makes exactly one provider call when a concurrent replay finds the operation in flight', async () => {
    let reserved = false
    boundary.reserve.mockImplementation(async () => {
      if (!reserved) {
        reserved = true
        return { operationId, email: 'person@example.com', state: 'reserved', validationStatus: null, replayed: false }
      }
      return { operationId, email: 'person@example.com', state: 'reserved', validationStatus: null, replayed: true }
    })
    boundary.validate.mockResolvedValue(receipt)
    boundary.finalize.mockResolvedValue({ operationId, email: 'person@example.com', state: 'completed', validationStatus: 'valid', replayed: false })

    const responses = await Promise.all([POST(request()), POST(request())])
    const statuses = responses.map((response) => response.status).sort()
    expect(statuses).toEqual([200, 202])
    expect(boundary.validate).toHaveBeenCalledTimes(1)
    const replay = await responses.find((response) => response.status === 202)!.json()
    expect(replay.result.replayed).toBe(true)
    expect(replay.result.state).toBe('reserved')
  })

  it('returns a reconciliation receipt on persistence failure and never re-calls the provider for the same operation', async () => {
    let reserved = false
    boundary.reserve.mockImplementation(async () => {
      if (!reserved) {
        reserved = true
        return { operationId, email: 'person@example.com', state: 'reserved', validationStatus: null, replayed: false }
      }
      return { operationId, email: 'person@example.com', state: 'reserved', validationStatus: null, replayed: true }
    })
    boundary.validate.mockResolvedValue(receipt)
    boundary.finalize.mockRejectedValueOnce(new ValidationRepositoryError('lead_validation:finalize_failed'))

    const first = await POST(request())
    expect(first.status).toBe(502)
    const body = await first.json()
    expect(body.error.code).toBe('reconciliation_needed')
    expect(body.receipt.providerStatus).toBe('valid')
    expect(body.receipt.providerEmailMatched).toBe(true)
    expect(JSON.stringify(body)).not.toContain('person@example.com')
    expect(boundary.validate).toHaveBeenCalledTimes(1)
    // It must never overwrite the paid receipt as an unknown.
    expect(body.receipt.providerStatus).not.toBe('unknown')

    const retry = await POST(request())
    expect(retry.status).toBe(202)
    expect(boundary.validate).toHaveBeenCalledTimes(1)
  })

  it('records a transport timeout as a held unknown without overwriting prior evidence', async () => {
    boundary.reserve.mockResolvedValue({ operationId, email: 'person@example.com', state: 'reserved', validationStatus: null, replayed: false })
    boundary.validate.mockRejectedValue(new ZeroBounceTimeoutError())
    boundary.finalize.mockResolvedValue({ operationId, email: 'person@example.com', state: 'held_unknown', validationStatus: 'valid', replayed: false })

    const response = await POST(request())
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.result.state).toBe('held_unknown')
    expect(body.warning).toMatch(/deadline/i)
    expect(boundary.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ providerStatus: 'unknown', substatus: 'timeout', reference: null })
    )
    // The trusted server receive time, not the provider's, is used for checkedAt.
    const args = boundary.finalize.mock.calls[0][0]
    expect(typeof args.checkedAt).toBe('string')
    expect(Number.isNaN(Date.parse(args.checkedAt))).toBe(false)
  })

  it('maps a new-UUID bypass of an unresolved attempt to a 409 and never calls the provider', async () => {
    boundary.reserve.mockRejectedValue(new ValidationRepositoryError('lead_validation:unresolved_operation'))
    const response = await POST(request())
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe('unresolved_operation')
    expect(boundary.validate).not.toHaveBeenCalled()
  })
})
