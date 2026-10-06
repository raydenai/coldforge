import { createClient } from '@supabase/supabase-js'
import type { Json } from '@/types/database'
import { z } from 'zod'
import { WinnrApiError } from '@/lib/winnr/server'
import type { DispatchRepository } from './dispatch'
const json:z.ZodType<Json>=z.lazy(()=>z.union([z.null(),z.string(),z.boolean(),z.number(),z.array(json),z.record(z.string(),json)]))
interface DispatchDatabase {public:{Tables:Record<string,never>;Views:Record<string,never>;Functions:{email_dispatch_mutate:{Args:{p_actor:string;p_org:string;p_action:string;p_payload:Json};Returns:Json}};Enums:Record<string,never>;CompositeTypes:Record<string,never>}}
/** Optional absolute request deadline; each RPC is capped by the remaining budget. */
export interface EmailDispatchRepositoryOptions {deadlineAt?:number}
export function createEmailDispatchRepository(options:EmailDispatchRepositoryOptions={}):DispatchRepository {
 const url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY
 if(!url||!key)throw new WinnrApiError(503,'service_unavailable','Email dispatch storage is not configured')
 const client=createClient<DispatchDatabase>(url,key,{auth:{persistSession:false,autoRefreshToken:false}})
 return {async call(actor,org,action,payload){
  const remaining=options.deadlineAt===undefined?8000:options.deadlineAt-Date.now()
  if(remaining<=0)throw new WinnrApiError(503,'service_unavailable','Email dispatch storage deadline exceeded')
  const clean=Object.fromEntries(Object.entries(payload).filter(([,v])=>v!==undefined))
  const {data,error}=await client.rpc('email_dispatch_mutate',{p_actor:actor,p_org:org,p_action:action,p_payload:json.parse(clean)}).abortSignal(AbortSignal.timeout(Math.max(1,Math.min(8000,remaining))))
  if(error){const code=/email_dispatch:([a-z_]+)/.exec(error.message)?.[1];throw new WinnrApiError(code==='forbidden'?403:409,code==='forbidden'?'forbidden':'bad_request',code??'Dispatch storage failed')}
  return data
 }}
}
