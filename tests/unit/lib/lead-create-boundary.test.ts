import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
const boundary=vi.hoisted(()=>({user:vi.fn(),from:vi.fn(),admin:vi.fn(),limit:vi.fn()}))
vi.mock('@/lib/supabase/server',()=>({createClient:async()=>({auth:{getUser:boundary.user},from:boundary.from})}))
vi.mock('@/lib/supabase/admin',()=>({createAdminClient:boundary.admin}))
vi.mock('@/lib/rate-limit/middleware',()=>({apiLimiter:{},writeLimiter:{},applyRateLimit:()=>({limited:false,result:{}}),addRateLimitHeaders:(response:unknown)=>response}))
import { POST } from '@/app/api/leads/route'
import { POST as createList } from '@/app/api/leads/lists/route'
const organization='11111111-1111-4111-8111-111111111111', foreignList='22222222-2222-4222-8222-222222222222'
const req=(body:unknown,origin='https://fixture.example')=>new NextRequest('https://fixture.example/api/leads',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)})
beforeEach(()=>{vi.clearAllMocks();boundary.user.mockResolvedValue({data:{user:{id:'own-user'}},error:null});boundary.from.mockImplementation((table:string)=>{const chain={select:()=>chain,eq:(column:string,value:string)=>{boundary.limit(table,column,value);return chain},single:async()=>({data:table==='users'?{organization_id:organization}:null,error:null})};return chain})})
describe('lead creation tenant and input boundaries',()=>{
 it('does not use privileged storage when unauthenticated',async()=>{boundary.user.mockResolvedValue({data:{user:null},error:null});expect((await POST(req({email:'lead@example.com'}))).status).toBe(401);expect(boundary.admin).not.toHaveBeenCalled()})
 it('rejects a foreign list before constructing privileged storage',async()=>{expect((await POST(req({email:'lead@example.com',listId:foreignList}))).status).toBe(400);expect(boundary.limit).toHaveBeenCalledWith('lead_lists','organization_id',organization);expect(boundary.admin).not.toHaveBeenCalled()})
 it('rejects foreign-origin writes',async()=>{expect((await POST(req({email:'lead@example.com'},'https://foreign.example'))).status).toBe(403);expect(boundary.admin).not.toHaveBeenCalled()})
 it.each([{name:123},{name:''},{name:'Fixture',organization_id:'foreign'}])('rejects malformed or caller-selected tenant for list creation',async(body)=>{expect((await createList(req(body))).status).toBe(400);expect(boundary.admin).not.toHaveBeenCalled()})
})
