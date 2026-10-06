import { describe, it, expect, vi } from 'vitest'
const reads=vi.hoisted(()=>({from:vi.fn()}))
vi.mock('@/lib/supabase/server',()=>({createClient:async()=>({from:reads.from})}))
import { readDashboardCounts } from '@/lib/email-core/dashboard'
describe('measured dashboard counts',()=>{
 it('preserves measured zero and unavailable counts separately, scoped to tenant',async()=>{
  const filters:unknown[][]=[]
  reads.from.mockImplementation((table:string)=>({select:()=>({eq:(...args:unknown[])=>{filters.push([table,...args]);return table==='replies'?{eq:async()=>({count:3,error:null})}:Promise.resolve(table==='campaigns'?{count:0,error:null}:{count:null,error:{code:'unavailable'}})}})}))
  expect(await readDashboardCounts('tenant-a')).toEqual({totalCampaigns:0,totalLeads:null,unreadReplies:3})
  expect(filters).toEqual([['campaigns','organization_id','tenant-a'],['leads','organization_id','tenant-a'],['replies','organization_id','tenant-a']])
 })
})
