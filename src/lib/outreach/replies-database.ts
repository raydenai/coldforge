import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { Json } from '@/types/database'
import type { DispatchRepository } from './dispatch'
import { WinnrApiError } from '@/lib/winnr/server'
const json:z.ZodType<Json>=z.lazy(()=>z.union([z.null(),z.string(),z.boolean(),z.number(),z.array(json),z.record(z.string(),json)]))
interface ReplyDatabase{public:{Tables:Record<string,never>;Views:Record<string,never>;Functions:{email_dispatch_mutate:{Args:{p_actor:string;p_org:string;p_action:string;p_payload:Json};Returns:Json};outreach_reply_mutate:{Args:{p_actor:string;p_org:string;p_action:string;p_payload:Json};Returns:Json}};Enums:Record<string,never>;CompositeTypes:Record<string,never>}}
export function createReplyRepository(shared=false,deadlineAt?:number):DispatchRepository{
 const url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.SUPABASE_SERVICE_ROLE_KEY
 if(!url||!key)throw new WinnrApiError(503,'service_unavailable','Reply storage unavailable')
 const timeoutSignal=()=>AbortSignal.timeout(deadlineAt===undefined?4000:Math.max(1,Math.min(4000,deadlineAt-Date.now())))
 const client=createClient<ReplyDatabase>(url,key,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>{const signal=init?.signal?AbortSignal.any([timeoutSignal(),init.signal]):timeoutSignal();return fetch(input,{...init,signal})}}})
 return{async call(actor,org,action,payload){
  if(deadlineAt!==undefined&&deadlineAt-Date.now()<=0)throw new WinnrApiError(503,'service_unavailable','Reply storage deadline exceeded')
  const {data,error}=await client.rpc(shared?'email_dispatch_mutate':'outreach_reply_mutate',{p_actor:actor,p_org:org,p_action:action,p_payload:json.parse(Object.fromEntries(Object.entries(payload).filter(([,value])=>value!==undefined)))});if(error)throw new WinnrApiError(error.message.includes('reply:forbidden')?403:409,'conflict','Reply context or storage changed');return data}}
}
