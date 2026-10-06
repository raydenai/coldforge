import { createHmac } from 'node:crypto'
import { NextRequest } from 'next/server'
import { beforeEach,describe,expect,it,vi } from 'vitest'
import { POST as receive } from '@/app/api/winnr/webhooks/[endpointId]/route'
import { POST as configure } from '@/app/api/outreach/ingestion/route'
import { WinnrApiError } from '@/lib/winnr/server'
const state=vi.hoisted(()=>({endpoint:vi.fn(),persist:vi.fn(),auth:vi.fn(),build:vi.fn(),configure:vi.fn()}))
vi.mock('@/lib/outreach/ingestion-database',()=>({createIngestionRepository:()=>{state.build();return{endpoint:state.endpoint,persist:state.persist}}}))
vi.mock('@/lib/outreach/ingestion-service',async original=>{const actual=await original<typeof import('@/lib/outreach/ingestion-service')>();return{...actual,configureIngestion:state.configure}})
vi.mock('@/app/api/winnr/_shared',async original=>{const actual=await original<typeof import('@/app/api/winnr/_shared')>();return{...actual,resolveAuthContext:state.auth}})
const secret='whsec_synthetic',endpointId='11111111-1111-4111-8111-111111111111'
beforeEach(()=>{vi.clearAllMocks();state.endpoint.mockResolvedValue({id:endpointId,organizationId:'org',connectionId:'conn',connectionVersion:1,providerAccountId:'acct_own',secret})})
function signed(body:string){const timestamp=String(Math.floor(Date.now()/1000));return new NextRequest(`https://app.example/api/winnr/webhooks/${endpointId}`,{method:'POST',body,headers:{'x-winnr-timestamp':timestamp,'x-winnr-signature':`v1=${createHmac('sha256',secret).update(`${timestamp}.${body}`).digest('hex')}`,'x-winnr-event-id':'evt_one','x-winnr-event':'test.ping'}})}
describe('ingestion HTTP admission and acknowledgement',()=>{
 it('rejects malformed unauthenticated payload before parsing or persistence',async()=>{const request=new NextRequest(`https://app.example/api/winnr/webhooks/${endpointId}`,{method:'POST',body:'not JSON'});expect((await receive(request,{params:Promise.resolve({endpointId})})).status).toBe(401);expect(state.persist).not.toHaveBeenCalled()})
 it('returns500 if durable receipt fails instead of acknowledging',async()=>{state.persist.mockRejectedValue(new Error('private DB details'));const response=await receive(signed(JSON.stringify({id:'evt_one',object:'event',type:'test.ping',api_version:'2026-08',created:new Date().toISOString(),account_id:'acct_own',data:{}})),{params:Promise.resolve({endpointId})});expect(response.status).toBe(500);expect(await response.text()).not.toContain('private DB')})
 it('requires cookie auth and owner/admin before constructing configuration dependencies',async()=>{state.auth.mockRejectedValue(new WinnrApiError(401,'unauthenticated','Auth required'));const request=new NextRequest('https://app.example/api/outreach/ingestion',{method:'POST',body:'{}',headers:{origin:'https://app.example'}});expect((await configure(request)).status).toBe(401);expect(state.configure).not.toHaveBeenCalled();state.auth.mockResolvedValue({userId:'member',organizationId:'org',role:'member'});expect((await configure(new NextRequest(request.url,{method:'POST',body:'{}',headers:{origin:'https://app.example'}}))).status).toBe(403);expect(state.configure).not.toHaveBeenCalled()})
 it('returns failure within the nine-second acknowledgement deadline when storage stalls',async()=>{
  vi.useFakeTimers()
  try {state.endpoint.mockImplementationOnce(()=>new Promise<never>(()=>{}));const pending=receive(signed('{}'),{params:Promise.resolve({endpointId})});await vi.advanceTimersByTimeAsync(9001);expect((await pending).status).toBe(500);expect(state.persist).not.toHaveBeenCalled()}finally{vi.useRealTimers()}
 })

})
