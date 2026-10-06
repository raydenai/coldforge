import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const boundary = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  userSelect: vi.fn(),
  userEq: vi.fn(),
  userSingle: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: boundary.getUser }, from: boundary.from }),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/rate-limit/middleware', () => ({
  apiLimiter: {},
  writeLimiter: {},
  applyRateLimit: () => ({ limited: false, result: {} }),
  addRateLimitHeaders: (response: unknown) => response,
}))

import { GET } from '@/app/api/leads/route'

const ORG = '11111111-1111-4111-8111-111111111111'
const USER = '22222222-2222-4222-8222-222222222222'
const LIST = '33333333-3333-4333-8333-333333333333'

type LeadsResult = { data: unknown; error: unknown; count: number | null }
type Recorder = { calls: Array<{ method: string; args: unknown[] }> }

function makeLeadsChain(result: LeadsResult) {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const chain: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'ilike', 'order', 'range']) {
    chain[method] = (...args: unknown[]) => {
      calls.push({ method, args })
      return chain
    }
  }
  // Awaiting the builder resolves the configured Supabase result.
  chain.then = (resolve: (value: unknown) => unknown) => resolve(result)
  return { chain, calls }
}

function primeLeads(result: LeadsResult): Recorder {
  const recorder = makeLeadsChain(result)
  boundary.from.mockImplementation((table: string) =>
    table === 'users' ? boundary.userSelect() : recorder.chain,
  )
  return recorder
}

const request = (query = '') => new NextRequest(`https://fixture.example/api/leads${query}`)

beforeEach(() => {
  vi.clearAllMocks()
  boundary.getUser.mockResolvedValue({ data: { user: { id: USER } }, error: null })
  const usersChain = {
    select: boundary.userSelect,
    eq: boundary.userEq,
    single: boundary.userSingle,
  }
  boundary.userSelect.mockReturnValue(usersChain)
  boundary.userEq.mockReturnValue(usersChain)
  boundary.userSingle.mockResolvedValue({ data: { organization_id: ORG }, error: null })
})

describe('GET /api/leads server pagination, search and validation', () => {
  it('scopes to the organization and escapes email search before pagination', async () => {
    const recorder = primeLeads({ data: [{ id: 'lead-1' }], error: null, count: 1 })
    const response = await GET(request('?page=2&limit=25&search=Acme_Inc%25'))
    expect(response.status).toBe(200)
    const body = await response.json() as { pagination: Record<string, number> }
    expect(body.pagination).toEqual({ page: 2, limit: 25, total: 1, totalPages: 1 })

    const orgCall = recorder.calls.find(
      call => call.method === 'eq' && call.args[0] === 'organization_id',
    )
    expect(orgCall?.args).toEqual(['organization_id', ORG])

    const searchCall = recorder.calls.find(call => call.method === 'ilike')
    expect(searchCall?.args).toEqual(['email', '%Acme\\_Inc\\%%'])

    const methods = recorder.calls.map(call => call.method)
    expect(methods.indexOf('range')).toBeGreaterThan(methods.indexOf('eq'))
    expect(methods.indexOf('range')).toBeGreaterThan(methods.indexOf('ilike'))
  })

  it('applies the list filter in org scope and reports the API total', async () => {
    const recorder = primeLeads({ data: [], error: null, count: 0 })
    const response = await GET(request(`?page=1&limit=50&listId=${LIST}`))
    expect(response.status).toBe(200)
    const body = await response.json() as { pagination: Record<string, number> }
    expect(body.pagination.total).toBe(0)

    const orgCall = recorder.calls.find(
      call => call.method === 'eq' && call.args[0] === 'organization_id',
    )
    expect(orgCall?.args).toEqual(['organization_id', ORG])
    const listCall = recorder.calls.find(
      call => call.method === 'eq' && call.args[0] === 'list_id',
    )
    expect(listCall?.args).toEqual(['list_id', LIST])
    expect(recorder.calls.some(call => call.method === 'range')).toBe(true)
  })

  it('rejects invalid page, limit, listId and empty or oversized search', async () => {
    const recorder = primeLeads({ data: [], error: null, count: 0 })
    const queries = [
      '?page=0',
      '?page=abc',
      '?limit=0',
      '?limit=101',
      '?listId=not-a-uuid',
      '?search=',
      '?search=%20%20',
      `?search=${'a'.repeat(256)}`,
    ]
    for (const query of queries) {
      const response = await GET(request(query))
      expect(response.status).toBe(400)
    }
    expect(recorder.calls).toHaveLength(0)
  })

  it('defaults a bare read to page 1 with 50 rows from the API total', async () => {
    const recorder = primeLeads({ data: [], error: null, count: 120 })
    const response = await GET(request())
    expect(response.status).toBe(200)
    const body = await response.json() as { pagination: Record<string, number> }
    expect(body.pagination).toEqual({ page: 1, limit: 50, total: 120, totalPages: 3 })
    const rangeCall = recorder.calls.find(call => call.method === 'range')
    expect(rangeCall?.args).toEqual([0, 49])
  })
})
