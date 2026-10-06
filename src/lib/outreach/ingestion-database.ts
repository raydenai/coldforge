import { createClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { decrypt } from '@/lib/encryption'
import { getServiceRoleConfig } from '@/lib/winnr/database'
import { WinnrApiError } from '@/lib/winnr/server'
import type { IngestionEndpoint, WinnrInboundEvent } from './ingestion'
type Json = null|boolean|string|number|Json[]|{[key:string]:Json|undefined}
type Table<R> = {Row:R;Insert:Partial<R>;Update:Partial<R>;Relationships:[]}
type Endpoint = {id:string;organization_id:string;connection_id:string;connection_version:number;provider_account_id:string;webhook_id:string|null;secret_ciphertext:string|null}
export const ingestedMessageSchema=z.object({id:z.uuid(),organization_id:z.uuid(),connection_id:z.uuid(),connection_version:z.number().int(),provider_account_id:z.string(),account_id:z.uuid(),mailbox_id:z.string(),message_id:z.string(),in_reply_to:z.string().nullable(),from_email:z.email(),to_email:z.email(),reply_id:z.uuid(),body_status:z.enum(['pending','ready'])})
export type IngestedMessage=z.infer<typeof ingestedMessageSchema>
interface IngestionDatabase {public:{Tables:{winnr_ingestion_endpoints:Table<Endpoint>;winnr_ingestion_receipts:Table<{id:string;organization_id:string;endpoint_id:string;message_record_id:string|null;payload:Json}>;winnr_ingested_messages:Table<IngestedMessage>};Views:{[_ in never]:never};Functions:{
 winnr_prepare_ingestion:{Args:{p_actor:string;p_org:string;p_connection:string;p_version:number;p_webhook?:string;p_ciphertext?:string;p_events?:string[]};Returns:Json};
 winnr_receive_event:{Args:{p_endpoint:string;p_payload:Json;p_fingerprint:string;p_channel?:string};Returns:Json};
 winnr_save_ingested_body:{Args:{p_actor:string;p_org:string;p_message:string;p_uid:string;p_body:string;p_optout:boolean;p_connection:string;p_version:number};Returns:boolean};
 winnr_ingestion_is_ready:{Args:{p_org:string;p_connection:string;p_version:number};Returns:boolean};
 winnr_correlate_ingested:{Args:{p_org:string;p_message:string};Returns:boolean};
};Enums:{[_ in never]:never};CompositeTypes:{[_ in never]:never}}}
function failure(error:{message:string}):never {if(error.message.includes('ingestion:forbidden'))throw new WinnrApiError(403,'forbidden','Owner or admin required');if(/ingestion:(?:stale|.*conflict)/.test(error.message))throw new WinnrApiError(409,'conflict','Ingestion configuration or message changed');throw new WinnrApiError(500,'internal_error','Ingestion persistence failed')}
/** Bound one storage call by the remaining request budget (hard cap 4s). */
function ingestionSignal(deadlineAt?:number):AbortSignal {return AbortSignal.timeout(deadlineAt===undefined?4000:Math.max(1,Math.min(4000,deadlineAt-Date.now())))}
export function createIngestionRepository() {
 const {url,serviceRoleKey}=getServiceRoleConfig();const client=createClient<IngestionDatabase>(url,serviceRoleKey,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>{const fallback=AbortSignal.timeout(4000);const signal=init?.signal?AbortSignal.any([init.signal,fallback]):fallback;return fetch(input,{...init,signal})}}})
 return {
  async endpoint(id:string,deadlineAt?:number):Promise<IngestionEndpoint|null> {if(!z.uuid().safeParse(id).success)return null;const {data,error}=await client.from('winnr_ingestion_endpoints').select('*').eq('id',id).abortSignal(ingestionSignal(deadlineAt)).maybeSingle();if(error)failure(error);if(!data?.secret_ciphertext)return null;try{return{id:data.id,organizationId:data.organization_id,connectionId:data.connection_id,connectionVersion:data.connection_version,providerAccountId:data.provider_account_id,secret:decrypt(data.secret_ciphertext)}}catch{throw new WinnrApiError(503,'service_unavailable','Signing secret unavailable')}},
  async configuration(org:string,connection:string,version:number,deadlineAt?:number) {const {data,error}=await client.from('winnr_ingestion_endpoints').select('id,webhook_id').eq('organization_id',org).eq('connection_id',connection).eq('connection_version',version).abortSignal(ingestionSignal(deadlineAt)).maybeSingle();if(error)failure(error);return data?{endpointId:data.id,configured:Boolean(data.webhook_id),webhookId:data.webhook_id}:null},
  async prepare(actor:string,org:string,connection:string,version:number,webhook?:string,ciphertext?:string,events?:string[]) {const {data,error}=await client.rpc('winnr_prepare_ingestion',{p_actor:actor,p_org:org,p_connection:connection,p_version:version,...(webhook?{p_webhook:webhook,p_ciphertext:ciphertext,p_events:events}:{})});if(error)failure(error);return z.object({endpointId:z.uuid(),configured:z.boolean()}).parse(data)},
  async persist(endpoint:IngestionEndpoint,event:WinnrInboundEvent,fingerprint:string,channel:'webhook'|'sync'|'lookup'='webhook',deadlineAt?:number) {const {data,error}=await client.rpc('winnr_receive_event',{p_endpoint:endpoint.id,p_payload:{...event,data:{...event.data}},p_fingerprint:fingerprint,p_channel:channel}).abortSignal(ingestionSignal(deadlineAt));if(error)failure(error);return z.object({duplicate:z.boolean(),eventId:z.uuid()}).parse(data)},
  async pending(org:string,connection:string,version:number,mailboxId:string,messageIds:string[]) {if(!messageIds.length)return [];const {data,error}=await client.from('winnr_ingested_messages').select('*').eq('organization_id',org).eq('connection_id',connection).eq('connection_version',version).eq('mailbox_id',mailboxId).in('message_id',messageIds).limit(20);if(error)failure(error);return z.array(ingestedMessageSchema).parse(data)},
  async pendingCount(org:string,providerAccount:string,accountId:string) {const {count,error}=await client.from('winnr_ingested_messages').select('id',{count:'exact',head:true}).eq('organization_id',org).eq('provider_account_id',providerAccount).eq('account_id',accountId).eq('body_status','pending');if(error)failure(error);if(count===null)throw new WinnrApiError(500,'internal_error','Pending body count unavailable');return count},
  async messageForReceipt(org:string,receiptId:string,deadlineAt?:number) {
   const receipt=await client.from('winnr_ingestion_receipts').select('message_record_id').eq('organization_id',org).eq('id',receiptId).abortSignal(ingestionSignal(deadlineAt)).maybeSingle();if(receipt.error)failure(receipt.error);if(!receipt.data?.message_record_id)return null
   const result=await client.from('winnr_ingested_messages').select('*').eq('organization_id',org).eq('id',receipt.data.message_record_id).abortSignal(ingestionSignal(deadlineAt)).maybeSingle();if(result.error)failure(result.error);return result.data?ingestedMessageSchema.parse(result.data):null
  },
  async saveBody(actor:string,org:string,message:string,uid:string,body:string,optout:boolean,connection:string,version:number,deadlineAt?:number) {const {data,error}=await client.rpc('winnr_save_ingested_body',{p_actor:actor,p_org:org,p_message:message,p_uid:uid,p_body:body,p_optout:optout,p_connection:connection,p_version:version}).abortSignal(ingestionSignal(deadlineAt));if(error)failure(error);return data===true},
  async correlate(org:string,message:string,deadlineAt?:number) {const {data,error}=await client.rpc('winnr_correlate_ingested',{p_org:org,p_message:message}).abortSignal(ingestionSignal(deadlineAt));if(error)failure(error);return data===true},
 }
}
