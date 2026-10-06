import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
const boundary = vi.hoisted(() => ({ getUser: vi.fn(), bootstrap: vi.fn(), from: vi.fn(), select: vi.fn(), eq: vi.fn(), single: vi.fn() }))
vi.mock('@/lib/supabase/server',()=>({createClient:async()=>({auth:{getUser:boundary.getUser},from:boundary.from})}))
vi.mock('@/lib/email-core/identity',()=>({bootstrapIdentity:boundary.bootstrap}))
vi.mock('@/lib/audit',()=>({logAuditEventAsync:vi.fn(),getRequestMetadata:vi.fn()}))
import { POST } from '@/app/api/settings/organization/route'
const id='11111111-1111-4111-8111-111111111111'
const req=(body:unknown,origin:string|null='https://fixture.example')=>new NextRequest('https://fixture.example/api/settings/organization',{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify(body)})
beforeEach(()=>{vi.clearAllMocks();boundary.getUser.mockResolvedValue({data:{user:{id,email:'stable@example.com'}}});boundary.from.mockReturnValue({select:boundary.select});boundary.select.mockReturnValue({eq:boundary.eq});boundary.eq.mockReturnValue({single:boundary.single});boundary.single.mockResolvedValue({data:{id:'organization',name:'Fixture'},error:null});boundary.bootstrap.mockResolvedValue({organization_id:'organization',role:'owner'})})
describe('first-user bootstrap HTTP boundary',()=>{
 it('does not build a privileged bootstrap for anonymous callers',async()=>{boundary.getUser.mockResolvedValue({data:{user:null}});expect((await POST(req({name:'Fixture'}))).status).toBe(401);expect(boundary.bootstrap).not.toHaveBeenCalled()})
 it.each([null,'https://foreign.example'])('rejects missing or foreign origin %s',async(origin)=>{expect((await POST(req({name:'Fixture'},origin))).status).toBe(403);expect(boundary.bootstrap).not.toHaveBeenCalled()})
 it.each([{name:'Fixture',userId:'foreign'},{name:'Fixture',organizationId:'foreign'},{name:'Fixture',role:'owner'},{name:''}])('rejects caller-selected membership or invalid display data',async(body)=>{expect((await POST(req(body))).status).toBe(400);expect(boundary.bootstrap).not.toHaveBeenCalled()})
 it('only forwards verified session identity and bounded display name',async()=>{expect((await POST(req({name:' Fixture '}))).status).toBe(200);expect(boundary.bootstrap).toHaveBeenCalledWith(id,'Fixture')})
})
