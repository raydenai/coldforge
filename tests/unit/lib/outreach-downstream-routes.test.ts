import {beforeEach,describe,expect,it,vi} from 'vitest'
import {NextRequest} from 'next/server'
import {WinnrApiError} from '@/lib/winnr/server'
const b=vi.hoisted(()=>({auth:vi.fn(),deps:vi.fn(),eligibility:vi.fn(),webhook:vi.fn(),secret:vi.fn()}))
vi.mock('@/app/api/winnr/_shared',async original=>({...await original<typeof import('@/app/api/winnr/_shared')>(),resolveAuthContext:b.auth}))
vi.mock('@/lib/outreach/downstream/service',async original=>({...await original<typeof import('@/lib/outreach/downstream/service')>(),createDownstreamServiceDeps:b.deps,recordEligibility:b.eligibility}))
vi.mock('@/lib/outreach/downstream/database',()=>({createDownstreamRepository:()=>({connectionSecret:b.secret,recordWebhookEvent:b.webhook})}))
vi.mock('@/lib/outreach/downstream/providers',async original=>({...await original<typeof import('@/lib/outreach/downstream/providers')>(),verifyGhlSignature:()=>true}))
import {POST as GHL} from '@/app/api/webhooks/downstream/[organizationId]/ghl/route'
import {GET,POST} from '@/app/api/outreach/downstream/route'
const id='11111111-1111-4111-8111-111111111111',org='22222222-2222-4222-8222-222222222222'
const value={action:'recordEligibility',leadId:id,phoneE164:'+14155550100',timezone:'America/Los_Angeles',windowStartHour:9,windowEndHour:17,expiresAt:'2026-10-10T18:00:00.000Z',maxCalls:1,consentBasis:'Explicit owner consent',evidence:'Synthetic fixture record'}
const request=(body:unknown=value,origin:string|null='https://fixture.example')=>new NextRequest('https://fixture.example/api/outreach/downstream',{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{})},body:JSON.stringify(body)})
beforeEach(()=>{vi.clearAllMocks();b.auth.mockResolvedValue({userId:id,organizationId:org,role:'owner'});b.deps.mockReturnValue({fixture:true});b.eligibility.mockResolvedValue({saved:true,eligibilityId:id});b.secret.mockResolvedValue({configured:true});b.webhook.mockResolvedValue({result:'recorded'})})
describe('downstream HTTP authorization and real input schema',()=>{
 it('never constructs privileged storage without cookie authentication',async()=>{b.auth.mockRejectedValue(new WinnrApiError(401,'unauthenticated','Authentication required'));expect((await POST(request())).status).toBe(401);expect(b.deps).not.toHaveBeenCalled()})
 it('members cannot construct service storage for reads or mutations',async()=>{b.auth.mockResolvedValue({userId:id,organizationId:org,role:'member'});expect((await POST(request())).status).toBe(403);expect((await GET()).status).toBe(403);expect(b.deps).not.toHaveBeenCalled()})
 it.each([null,'https://foreign.example'])('rejects Origin %s before any storage',async origin=>{expect((await POST(request(value,origin))).status).toBe(403);expect(b.deps).not.toHaveBeenCalled()})
 it('rejects manual global ticks and caller selected tenant',async()=>{expect((await POST(request({action:'tick'}))).status).toBe(400);expect((await POST(request({...value,organizationId:org}))).status).toBe(400);expect(b.deps).not.toHaveBeenCalled()})
 it('accepts explicit ISO expiry and uses only cookie organization/actor',async()=>{expect((await POST(request())).status).toBe(200);expect(b.eligibility).toHaveBeenCalledWith({userId:id,organizationId:org,role:'owner'},expect.objectContaining({expiresAt:value.expiresAt}),{fixture:true},expect.any(Number))})
 it('rejects ambiguous datetime-local expiry instead of assuming server locale',async()=>{expect((await POST(request({...value,expiresAt:'2026-10-10T18:00'}))).status).toBe(400);expect(b.eligibility).not.toHaveBeenCalled()})
 it('keeps legitimate successive GHL updates separate and identical retries on one event identity',async()=>{
  const context={params:Promise.resolve({organizationId:org})}
  const invoke=(startTime:string)=>GHL(new NextRequest(`https://fixture.example/api/webhooks/downstream/${org}/ghl`,{method:'POST',headers:{'x-ghl-signature':'synthetic-verified-fixture'},body:JSON.stringify({type:'AppointmentUpdate',appointmentId:'appointment',locationId:'location',startTime})}),context)
  expect((await invoke('2026-10-10T18:00:00Z')).status).toBe(202);expect((await invoke('2026-10-11T18:00:00Z')).status).toBe(202);expect((await invoke('2026-10-11T18:00:00Z')).status).toBe(202)
  const payloads=b.webhook.mock.calls.map(call=>call[1] as {eventKey:string});expect(payloads[0]?.eventKey).not.toBe(payloads[1]?.eventKey);expect(payloads[1]?.eventKey).toBe(payloads[2]?.eventKey)
 })

})
