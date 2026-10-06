import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
const boundary = vi.hoisted(() => ({ getUser: vi.fn(), from: vi.fn(), select: vi.fn(), eq: vi.fn(), single: vi.fn(), connection: vi.fn(), syncDeps: vi.fn(), status: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: boundary.getUser }, from: boundary.from }) }))
vi.mock('@/lib/winnr/database', async original => ({ ...await original<typeof import('@/lib/winnr/database')>(), createServiceRoleRepository: () => ({ getConnection: boundary.connection }) }))
vi.mock('@/lib/winnr/smtp-database', async original => ({ ...await original<typeof import('@/lib/winnr/smtp-database')>(), createWinnrSmtpRepository: () => ({ status: boundary.status }) }))
vi.mock('@/lib/winnr/smtp', async original => ({ ...await original<typeof import('@/lib/winnr/smtp')>(), createWinnrSmtpSyncDeps: boundary.syncDeps }))
import { GET, POST } from '@/app/api/winnr/smtp/route'
const org = '11111111-1111-4111-8111-111111111111'; const conn = '22222222-2222-4222-8222-222222222222'
function request(origin='https://app.example') { return new NextRequest('https://app.example/api/winnr/smtp',{ method:'POST',headers:{origin},body:JSON.stringify({expectedConnectionId:conn,expectedConnectionVersion:1,mailboxIds:['mb-1']}) }) }
beforeEach(() => {
  vi.resetAllMocks(); boundary.getUser.mockResolvedValue({data:{user:{id:'authenticated-user'}}})
  boundary.from.mockReturnValue({select:boundary.select}); boundary.select.mockReturnValue({eq:boundary.eq}); boundary.eq.mockReturnValue({single:boundary.single})
  boundary.single.mockResolvedValue({data:{organization_id:org,role:'member'}})
  boundary.connection.mockResolvedValue({id:conn,version:1}); boundary.status.mockResolvedValue([{providerMailboxId:'mb-1',email:'sender@example.test',accountId:'mapped-account',syncedAt:'now'}])
})
describe('Winnr SMTP HTTP authorization boundary', () => {
  it('denies unauthenticated reads before credential storage lookup', async () => {
    boundary.getUser.mockResolvedValue({data:{user:null}})
    expect((await GET()).status).toBe(401); expect(boundary.connection).not.toHaveBeenCalled()
  })
  it('lets members read nonsecret status but never import credentials', async () => {
    const response = await GET(); expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({connectionId:conn,mailboxes:[{providerMailboxId:'mb-1'}]})
    expect((await POST(request())).status).toBe(403); expect(boundary.syncDeps).not.toHaveBeenCalled()
  })
  it('denies cross-origin import before provider/storage construction', async () => {
    boundary.single.mockResolvedValue({data:{organization_id:org,role:'owner'}})
    expect((await POST(request('https://evil.example'))).status).toBe(403); expect(boundary.syncDeps).not.toHaveBeenCalled()
  })
})
