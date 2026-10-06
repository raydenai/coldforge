import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'
const reads=vi.hoisted(()=>({from:vi.fn(),filters:vi.fn()}))
vi.mock('@/lib/supabase/server',()=>({createClient:async()=>({auth:{getUser:async()=>({data:{user:{id:'own-user'}},error:null})},from:reads.from})}))
import { GET } from '@/app/api/inbox/[id]/route'
describe('canonical saved inbox read',()=>{
 it('reads a saved timeline without a nonexistent local mailbox relation',async()=>{
  reads.from.mockImplementation((table:string)=>{
   const thread={id:'thread-a',organization_id:'org-a',leads:null,campaigns:null,subject:'Saved conversation'}
   const result=table==='replies'?[{id:'reply-a',status:'read',received_at:'2026-10-05T00:00:00Z',body_text:'Saved inbound'}]:table==='threads'?[thread]:[]
   const chain={select:(columns:string)=>{if(columns.includes('mailboxes:'))throw new Error('Unknown relation');return chain},eq:(column:string,value:string)=>{reads.filters(table,column,value);return chain},neq:()=>chain,order:async()=>({data:result,error:null}),single:async()=>({data:table==='users'?{organization_id:'org-a'}:thread,error:null})};return chain
  })
  const response=await GET(new NextRequest('https://fixture.example/api/inbox/thread-a'),{params:Promise.resolve({id:'thread-a'})})
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({thread:{id:'thread-a'},mailbox:null,timeline:[{id:'reply-a',bodyText:'Saved inbound'}]})
  expect(reads.filters).toHaveBeenCalledWith('threads','organization_id','org-a')
  expect(reads.filters).toHaveBeenCalledWith('replies','organization_id','org-a')
 })
})
