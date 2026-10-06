import { describe,it,expect,vi,beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { WinnrApiError } from '@/lib/winnr/server'
const boundary=vi.hoisted(()=>({auth:vi.fn(),deps:vi.fn(),call:vi.fn()}))
vi.mock('@/app/api/winnr/_shared',async(importOriginal)=>{const original=await importOriginal<typeof import('@/app/api/winnr/_shared')>();return {...original,resolveAuthContext:boundary.auth}})
vi.mock('@/lib/outreach/dispatch-runtime',()=>({createEmailDispatchDeps:boundary.deps,readEmailDispatchReadiness:vi.fn()}))
import { POST } from '@/app/api/outreach/dispatch/route'
const org='11111111-1111-4111-8111-111111111111',campaign='22222222-2222-4222-8222-222222222222'
const request=(body:unknown,origin:string|null='https://fixture.example')=>new NextRequest('https://fixture.example/api/outreach/dispatch',{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify(body)})
beforeEach(()=>{vi.clearAllMocks();boundary.auth.mockResolvedValue({userId:'own-actor',organizationId:org,role:'owner'});boundary.deps.mockReturnValue({repository:{call:boundary.call}});boundary.call.mockResolvedValue({killed:true})})
describe('dispatch HTTP authority',()=>{
 it('never constructs transport storage for unauthenticated requests',async()=>{boundary.auth.mockRejectedValue(new WinnrApiError(401,'unauthenticated','Authentication required'));expect((await POST(request({action:'kill',campaignId:campaign}))).status).toBe(401);expect(boundary.deps).not.toHaveBeenCalled()})
 it('refuses member mutations before transport storage',async()=>{boundary.auth.mockResolvedValue({userId:'member',organizationId:org,role:'member'});expect((await POST(request({action:'kill',campaignId:campaign}))).status).toBe(403);expect(boundary.deps).not.toHaveBeenCalled()})
 it.each([null,'https://foreign.example'])('refuses missing/foreign origin %s before transport',async(origin)=>{expect((await POST(request({action:'kill',campaignId:campaign},origin))).status).toBe(403);expect(boundary.deps).not.toHaveBeenCalled()})
 it('forwards only canonical actor/tenant and bounds effects to one per request',async()=>{expect((await POST(request({action:'kill',campaignId:campaign}))).status).toBe(200);expect(boundary.call).toHaveBeenCalledWith('own-actor',org,'kill',{action:'kill',campaignId:campaign});expect((await POST(request({action:'dispatch',campaignId:campaign,limit:20}))).status).toBe(400)})
 it('rejects body-selected organization and invalid identity input',async()=>{expect((await POST(request({action:'kill',campaignId:campaign,organizationId:'foreign'}))).status).toBe(400);expect(boundary.deps).not.toHaveBeenCalled()})
})
