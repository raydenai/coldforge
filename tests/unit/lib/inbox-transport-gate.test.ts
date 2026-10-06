import { describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
const boundary = vi.hoisted(() => ({ getUser: vi.fn(), from: vi.fn(), select: vi.fn(), eq: vi.fn(), single: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: boundary.getUser }, from: boundary.from }) }))
import { POST as reply } from '@/app/api/inbox/[id]/reply/route'
import { POST as sync } from '@/app/api/inbox/sync/route'
function request() { return new NextRequest('https://review.example/api/inbox/sync', { method: 'POST', headers: { origin: 'https://review.example', 'content-type': 'application/json' }, body: '{}' }) }
describe('inbox input and authority gates', () => {
  it('rejects unauthenticated requests', async () => {
    boundary.getUser.mockResolvedValue({ data: { user: null } })
    expect((await reply(request(), { params: Promise.resolve({ id: 'thread-1' }) })).status).toBe(401)
    expect((await sync(request())).status).toBe(401)
  })
  it('rejects invalid reply identity and empty sync input without reporting a provider effect', async () => {
    boundary.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
    boundary.from.mockReturnValue({ select: boundary.select }); boundary.select.mockReturnValue({ eq: boundary.eq })
    boundary.eq.mockReturnValue({ single: boundary.single }); boundary.single.mockResolvedValue({ data: { organization_id: '22222222-2222-4222-8222-222222222222', role: 'owner' } })
    for (const response of [await reply(request(), { params: Promise.resolve({ id: 'thread-1' }) }), await sync(request())]) {
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: 'bad_request' } })
    }
  })
})
