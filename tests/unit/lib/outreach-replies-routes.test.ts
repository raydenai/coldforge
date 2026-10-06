import { beforeEach,describe,it,expect,vi } from 'vitest'
import { NextRequest } from 'next/server'
import { WinnrApiError } from '@/lib/winnr/server'
const b=vi.hoisted(()=>({auth:vi.fn(),deps:vi.fn(),send:vi.fn(),repo:vi.fn(),call:vi.fn()}))
vi.mock('@/app/api/winnr/_shared',async original=>({...await original<typeof import('@/app/api/winnr/_shared')>(),resolveAuthContext:b.auth}))
vi.mock('@/lib/outreach/replies-runtime',()=>({createReplyDeps:b.deps}))
vi.mock('@/lib/outreach/replies-database',()=>({createReplyRepository:b.repo}))
vi.mock('@/lib/outreach/replies',async original=>({...await original<typeof import('@/lib/outreach/replies')>(),sendManualReply:b.send}))
import { POST } from '@/app/api/inbox/[id]/reply/route'
import { POST as CONTROL } from '@/app/api/inbox/[id]/control/route'
const id='11111111-1111-4111-8111-111111111111',org='22222222-2222-4222-8222-222222222222',actor='33333333-3333-4333-8333-333333333333'
const body={message:'Human reply',sourceReplyId:'44444444-4444-4444-8444-444444444444',controlRevision:2},ctx={params:Promise.resolve({id})}
const request=(value:unknown=body,origin:string|null='https://fixture.example')=>new NextRequest(`https://fixture.example/api/inbox/${id}/reply`,{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify(value)})
beforeEach(()=>{vi.clearAllMocks();b.auth.mockResolvedValue({userId:actor,organizationId:org,role:'owner'});b.deps.mockReturnValue({fixture:true});b.send.mockResolvedValue({accepted:true,attemptId:id,receipt:{outcome:'accepted',messageId:'<id@example.test>',recipient:'lead@example.test'},deliveryEvidence:'smtp_acceptance_only'});b.repo.mockReturnValue({call:b.call});b.call.mockResolvedValue({allowed:true})})
describe('reply HTTP authority',()=>{
 it('unauthenticated request never constructs privileged reply storage',async()=>{b.auth.mockRejectedValue(new WinnrApiError(401,'unauthenticated','Authentication required'));expect((await POST(request(),ctx)).status).toBe(401);expect(b.deps).not.toHaveBeenCalled()})
 it('ordinary member cannot construct reply storage',async()=>{b.auth.mockResolvedValue({userId:actor,organizationId:org,role:'member'});expect((await POST(request(),ctx)).status).toBe(403);expect(b.deps).not.toHaveBeenCalled()})
 it.each([null,'https://foreign.example'])('missing/foreign Origin refused before service %s',async origin=>{expect((await POST(request(body,origin),ctx)).status).toBe(403);expect(b.deps).not.toHaveBeenCalled()})
 it('body-selected organization, recipient, headers and message ID are forbidden',async()=>{for(const field of ['organizationId','to','headers','messageId'])expect((await POST(request({...body,[field]:'caller-selected'}),ctx)).status).toBe(400);expect(b.deps).not.toHaveBeenCalled()})
 it('uses only cookie tenant/actor and returns acceptance evidence without token',async()=>{const r=await POST(request(),ctx);expect(r.status).toBe(200);expect(b.send).toHaveBeenCalledWith(actor,org,id,body,{fixture:true});expect(await r.text()).not.toMatch(/token|ciphertext|secret/);expect(b.send).toHaveBeenCalledTimes(1)})
 it('control mutation enforces owner role and current origin before storage',async()=>{expect((await CONTROL(request({mode:'human',expectedRevision:1},null),ctx)).status).toBe(403);expect(b.repo).not.toHaveBeenCalled();expect((await CONTROL(request({mode:'human',expectedRevision:1}),ctx)).status).toBe(200);expect(b.call).toHaveBeenCalledWith(actor,org,'control',{threadId:id,mode:'human',expectedRevision:1})})
})
