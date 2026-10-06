import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { createClient } from '@supabase/supabase-js'
const boundary = vi.hoisted(() => ({ getUser: vi.fn(), from: vi.fn(), select: vi.fn(), eq: vi.fn(), single: vi.fn(), factory: vi.fn(), mailboxes: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: boundary.getUser }, from: boundary.from }) }))
vi.mock('@/lib/campaigns/repository', async original => ({ ...await original<typeof import('@/lib/campaigns/repository')>(), createCampaignRepository: boundary.factory }))
vi.mock('@/lib/winnr/server', async original => ({ ...await original<typeof import('@/lib/winnr/server')>(), listMailboxes: boundary.mailboxes }))
vi.mock('@/lib/winnr/database', async original => ({ ...await original<typeof import('@/lib/winnr/database')>(), createServiceRoleRepository: () => ({}) }))
import { CampaignCoreRepository, type CampaignCoreDatabase } from '@/lib/campaigns/repository'
import { GET, POST } from '@/app/api/campaigns/route'
import { GET as detail } from '@/app/api/campaigns/[id]/route'
import { GET as leads } from '@/app/api/campaigns/[id]/leads/route'
import { PUT as sequences } from '@/app/api/campaigns/[id]/sequences/route'

const org = '11111111-1111-4111-8111-111111111111'
const user = '22222222-2222-4222-8222-222222222222'
const id = '33333333-3333-4333-8333-333333333333'
const row = { id, organization_id: org, name: 'Offer', status: 'draft', settings: {}, stats: null, created_at: '2026-10-05T00:00:00Z', updated_at: '2026-10-05T00:00:00Z' }
let clientNumber = 0
const requests: { url: URL; body: unknown }[] = []
function request(path = '', method = 'GET', body?: unknown, origin = 'https://app.example') {
  return new NextRequest(`https://app.example/api/campaigns${path}`, { method, headers: { origin, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
const params = { params: Promise.resolve({ id }) }
beforeEach(() => {
  vi.resetAllMocks(); requests.length = 0
  boundary.getUser.mockResolvedValue({ data: { user: { id: user } }, error: null })
  boundary.from.mockReturnValue({ select: boundary.select }); boundary.select.mockReturnValue({ eq: boundary.eq }); boundary.eq.mockReturnValue({ single: boundary.single })
  boundary.single.mockResolvedValue({ data: { organization_id: org, role: 'owner' } })
  boundary.mailboxes.mockResolvedValue({ items: [{ id: 'provider-owned' }], nextCursor: null, connectionId: '44444444-4444-4444-8444-444444444444', connectionVersion: 1 })
  const transport = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input)); requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url.pathname.endsWith('/rpc/campaign_core_mutate')) return Response.json({ campaign: row, added: 1 })
    if (url.pathname.endsWith('/campaign_leads')) return Response.json([], { headers: { 'content-range': '0-0/0' } })
    return Response.json(url.searchParams.get('id') ? row : [row], { headers: { 'content-range': '0-0/1' } })
  }
  const repo = new CampaignCoreRepository(createClient<CampaignCoreDatabase>('https://storage.example', 'synthetic-service-key', { global: { fetch: transport }, auth: { persistSession: false, autoRefreshToken: false, storageKey: `campaign-core-fixture-${clientNumber++}` } }))
  boundary.factory.mockReturnValue(repo)
})
afterEach(() => vi.restoreAllMocks())
describe('campaign core real route boundaries', () => {
  it('requires cookie authentication before storage access', async () => {
    boundary.getUser.mockResolvedValue({ data: { user: null } })
    expect((await GET(request())).status).toBe(401)
    expect(requests).toHaveLength(0)
  })
  it('requires a real users organization membership', async () => {
    boundary.single.mockResolvedValue({ data: null })
    expect((await GET(request())).status).toBe(403)
    expect(requests).toHaveLength(0)
  })
  it('allows member reads but rejects member writes before storage', async () => {
    boundary.single.mockResolvedValue({ data: { organization_id: org, role: 'member' } })
    expect((await GET(request())).status).toBe(200)
    requests.length = 0
    expect((await POST(request('', 'POST', { name: 'Offer' }))).status).toBe(403)
    expect(requests).toHaveLength(0)
  })
  it('rejects a cross-origin mutation', async () => {
    expect((await POST(request('', 'POST', { name: 'Offer' }, 'https://foreign.example'))).status).toBe(403)
    expect(requests).toHaveLength(0)
  })
  it('rejects caller organization and malformed bodies instead of silently dropping fields', async () => {
    expect((await POST(request('', 'POST', { name: 'Offer', organizationId: 'foreign' }))).status).toBe(400)
    expect((await POST(new NextRequest('https://app.example/api/campaigns', { method: 'POST', headers: { origin: 'https://app.example' }, body: '{' }))).status).toBe(400)
    expect(requests).toHaveLength(0)
  })
  it('uses actual campaigns/users tables and tenant scope with no missing joins', async () => {
    const response = await detail(request(`/${id}`), params)
    expect(response.status).toBe(200)
    expect((await response.json()).campaign.id).toBe(id)
    expect(boundary.from).toHaveBeenCalledWith('users')
    expect(requests[0]?.url.pathname).toBe('/rest/v1/campaigns')
    expect(requests[0]?.url.searchParams.get('organization_id')).toBe(`eq.${org}`)
    expect(requests[0]?.url.searchParams.get('select')).toBe('*')
  })
  it('filters enrolled lead ownership before server pagination using the real foreign key', async () => {
    expect((await leads(request(`/${id}/leads?page=2&limit=25`), params)).status).toBe(200)
    const query = requests.find(entry => entry.url.pathname.endsWith('/campaign_leads'))?.url
    expect(query?.searchParams.get('leads.organization_id')).toBe(`eq.${org}`)
    expect(query?.searchParams.get('select')).toContain('leads!inner')
    expect(query?.searchParams.has('lead_id')).toBe(false)
  })
  it('rejects unowned provider IDs without saving campaign state', async () => {
    expect((await POST(request('', 'POST', { name: 'Offer', mailboxIds: ['foreign-provider-id'] }))).status).toBe(400)
    expect(requests).toHaveLength(0)
  })
  it('binds verified provider IDs to the current organization connection', async () => {
    expect((await POST(request('', 'POST', { name: 'Offer', mailboxIds: ['provider-owned'] }))).status).toBe(200)
    expect(requests[0]?.body).toMatchObject({ p_actor: user, p_org: org, p_payload: { mailboxIds: ['provider-owned'], senderConnectionVersion: 1 } })
  })
  it('explicitly rejects multiple variants without overwriting existing rows', async () => {
    const variant = { id: 'v', name: 'A', weight: 100, subject: 'Offer', body: 'Hello', isPlainText: true }
    const response = await sequences(request(`/${id}/sequences`, 'PUT', { expectedUpdatedAt: row.updated_at, steps: [{ id: 's', order: 1, type: 'email', delayDays: 0, delayHours: 0, condition: 'always', variants: [variant, { ...variant, id: 'v2' }] }] }), params)
    expect(response.status).toBe(400)
    expect((await response.json()).error.message).toContain('Multiple variants')
    expect(requests).toHaveLength(0)
  })
})
