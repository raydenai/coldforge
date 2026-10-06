import { randomUUID } from 'node:crypto'
import { fingerprintWinnrSmtpMessage } from '@/lib/winnr/smtp-transport'
import { z } from 'zod'
import { createUnsubscribeToken } from '@/lib/compliance/unsubscribe-token'
import { WinnrApiError } from '@/lib/winnr/server'

export const dispatchMessageSchema = z.object({ from:z.string().email(),to:z.string().email(),subject:z.string().min(1).max(998).refine(v=>!/[\r\n\0]/.test(v)),text:z.string().max(200000).optional(),html:z.string().max(200000).optional(),messageId:z.string().regex(/^<[^<>\s@]+@[^<>\s@]+>$/),inReplyTo:z.string().optional(),references:z.array(z.string()).optional(),headers:z.record(z.string(),z.string()).optional() })
export type DispatchMessage = z.infer<typeof dispatchMessageSchema>
export const configurationSchema = z.object({ campaign_id:z.string().uuid(),organization_id:z.string().uuid(),sender_name:z.string().trim().min(1).max(100),sender_company:z.string().trim().min(1).max(200),business_address:z.string().trim().min(1).max(1000),sender_email:z.string().email(),mailbox_id:z.string().min(1),mailbox_daily_limit:z.number().int().min(1).max(1000),connection_id:z.string().uuid(),connection_version:z.number().int().positive(),killed:z.boolean() })
export const stepSchema = z.object({id:z.string().uuid(),campaign_id:z.string().uuid(),step_number:z.number().int().positive(),subject:z.string(),body_text:z.string().nullable(),body_html:z.string(),delay_days:z.number().nullable(),delay_hours:z.number().nullable(),condition_type:z.string().nullable(),created_at:z.string().nullable(),updated_at:z.string().nullable()})
const leadSchema=z.object({id:z.string().uuid(),email:z.string().email(),first_name:z.string().nullable(),last_name:z.string().nullable(),company:z.string().nullable(),title:z.string().nullable()}).passthrough()
export const candidateSchema=z.object({enrollmentId:z.string().uuid(),lead:leadSchema,step:stepSchema,configuration:configurationSchema})
export type DispatchCandidate=z.infer<typeof candidateSchema>
export interface DispatchSendInput { organizationId:string;connectionId:string;connectionVersion:number;mailboxId:string;claimToken:string;message:DispatchMessage }
export interface DispatchGrant { organizationId:string;connectionId:string;connectionVersion:number;mailboxId:string;claimToken:string;fingerprint:string;attemptId:string }
export type DispatchOutcome={outcome:'accepted';messageId:string;recipient:string}|{outcome:'rejected'|'unknown';code:string}
export interface DispatchRepository { call(actor:string,org:string,action:string,payload:Record<string,unknown>):Promise<unknown> }
export interface DispatchDeps { repository:DispatchRepository; transport:{send(input:DispatchSendInput):Promise<DispatchOutcome>}; mailboxAvailable(input:{organizationId:string;connectionId:string;connectionVersion:number;mailboxId:string;email:string;dailyLimit:number}):Promise<boolean>; appUrl:string }
export const fingerprintDispatchMessage = fingerprintWinnrSmtpMessage

function render(template:string,values:Record<string,string>,html=false) {
 if(/\{[^{}]*\|[^{}]*\}/.test(template)) throw new WinnrApiError(409,'bad_request','Spintax needs approved immutable copy before sending')
 const escaped=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;')
 const rendered=template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g,(_match:string,key:string)=>{const value=values[key];if(value===undefined||!value.trim())throw new WinnrApiError(409,'bad_request',`Unresolved campaign variable: ${key}`);return html?escaped(value):value})
 if(rendered.includes('{{')||rendered.includes('}}'))throw new WinnrApiError(409,'bad_request','Malformed campaign template')
 return rendered
}
export function renderDispatchMessage(candidate:DispatchCandidate,appUrl:string):DispatchMessage {
 const {lead,step,configuration:cfg}=candidate
 const url=new URL(appUrl);if(url.protocol!=='https:')throw new WinnrApiError(503,'service_unavailable','A HTTPS application URL is required for unsubscribe links')
 if(!['always','not_replied'].includes(step.condition_type??'always'))throw new WinnrApiError(409,'bad_request','Unsupported sequence condition')
 const values:Record<string,string>={first_name:lead.first_name??'',firstName:lead.first_name??'',last_name:lead.last_name??'',lastName:lead.last_name??'',email:lead.email,company:lead.company??'',title:lead.title??'',senderName:cfg.sender_name,sender_name:cfg.sender_name,senderCompany:cfg.sender_company,sender_company:cfg.sender_company,senderEmail:cfg.sender_email,sender_email:cfg.sender_email}
 const token=createUnsubscribeToken({leadId:lead.id,campaignId:cfg.campaign_id,workspaceId:cfg.organization_id})
 const unsubscribe=new URL('/unsubscribe',url);unsubscribe.searchParams.set('token',token)
 const escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;')
 const footer=`\n\n${cfg.sender_name}\n${cfg.sender_company}\n${cfg.business_address}\nUnsubscribe: ${unsubscribe.href}`
 const message:DispatchMessage={from:cfg.sender_email,to:lead.email.trim().toLowerCase(),subject:render(step.subject,values),messageId:`<${randomUUID()}@${cfg.sender_email.split('@')[1]}>`,headers:{'List-Unsubscribe':`<${unsubscribe.href}>`,'List-Unsubscribe-Post':'List-Unsubscribe=One-Click'}}
 if(step.body_text)message.text=render(step.body_text,values)+footer
 if(step.body_html)message.html=render(step.body_html,values,true)+`<hr><p>${escape(cfg.sender_name)}<br>${escape(cfg.sender_company)}<br>${escape(cfg.business_address)}<br><a href="${escape(unsubscribe.href)}">Unsubscribe</a></p>`
 if(!message.text&&!message.html)throw new WinnrApiError(409,'bad_request','Sequence body is empty')
 return dispatchMessageSchema.parse(message)
}
const grantSchema=z.object({organizationId:z.string().uuid(),connectionId:z.string().uuid(),connectionVersion:z.number().int().positive(),mailboxId:z.string(),claimToken:z.string().uuid(),fingerprint:z.string(),attemptId:z.string().uuid()})
export async function authorizeEmailDispatchClaim(repository:DispatchRepository,actor:string,input:DispatchSendInput&{fingerprint:string}):Promise<DispatchGrant|null> {
 const result=z.object({allowed:z.boolean().optional(),grant:grantSchema.optional()}).parse(await repository.call(actor,input.organizationId,'authorize',{...input,message:undefined}))
 return result.allowed&&result.grant?result.grant:null
}
export async function dispatchCampaign(actor:string,org:string,campaignId:string,limit:number,deps:DispatchDeps) {
 const data=z.object({ready:z.boolean().optional(),reason:z.string().optional(),candidates:z.array(candidateSchema).optional()}).parse(await deps.repository.call(actor,org,'candidates',{campaignId,limit:Math.min(Math.max(limit,1),1)}))
 if(!data.ready)throw new WinnrApiError(503,'service_unavailable',data.reason??'Dispatch unavailable')
 const outcomes:unknown[]=[]
 for(const candidate of (data.candidates??[]).slice(0,1)) {
  const cfg=candidate.configuration
  if(!await deps.mailboxAvailable({organizationId:org,connectionId:cfg.connection_id,connectionVersion:cfg.connection_version,mailboxId:cfg.mailbox_id,email:cfg.sender_email,dailyLimit:cfg.mailbox_daily_limit})) {outcomes.push({enrollmentId:candidate.enrollmentId,outcome:'blocked',code:'provider_mailbox_unavailable'});continue}
  const message=renderDispatchMessage(candidate,deps.appUrl)
  const reservation=z.object({allowed:z.boolean().optional(),reason:z.string().optional(),attempt:z.object({claim_token:z.string().uuid(),id:z.string().uuid()}).optional()}).parse(await deps.repository.call(actor,org,'reserve',{campaignId,enrollmentId:candidate.enrollmentId,message,fingerprint:fingerprintDispatchMessage(message),step:candidate.step,configuration:cfg}))
  if(!reservation.allowed||!reservation.attempt){outcomes.push({enrollmentId:candidate.enrollmentId,outcome:'blocked',code:reservation.reason??'not_reserved'});continue}
  const input={organizationId:org,connectionId:cfg.connection_id,connectionVersion:cfg.connection_version,mailboxId:cfg.mailbox_id,claimToken:reservation.attempt.claim_token,message}
  let receipt:DispatchOutcome
  try {receipt=await deps.transport.send(input)} catch {receipt={outcome:'unknown',code:'transport_exception'}}
  // Never resubmit on persistence failure. Return the recoverable receipt to this authorized operator.
  try {
   const settlement=await deps.repository.call(actor,org,'settle',{claimToken:input.claimToken,...receipt})
   outcomes.push({attemptId:reservation.attempt.id,receipt,settlement})
  } catch {outcomes.push({attemptId:reservation.attempt.id,receipt,outcome:'unknown',code:'receipt_persistence_failed'})}
 }
 return {outcomes,warmupReadiness:'unknown',deliveryEvidence:'smtp_acceptance_only'}
}
/** Explicit owner/admin retry of a proven pre-effect cancellation; unknown/authorized touches never qualify. */
export async function retryEmailDispatch(actor:string,org:string,campaignId:string,attemptId:string,deps:DispatchDeps) {
 const result=z.object({allowed:z.boolean().optional(),reason:z.string().optional(),configuration:configurationSchema.optional(),attempt:z.object({id:z.string().uuid(),claim_token:z.string().uuid(),message:dispatchMessageSchema}).optional()}).parse(await deps.repository.call(actor,org,'retry',{campaignId,attemptId}))
 if(!result.allowed||!result.attempt||!result.configuration)throw new WinnrApiError(409,'bad_request',result.reason??'Retry has not been proven safe')
 const cfg=result.configuration,a=result.attempt
 const available=await deps.mailboxAvailable({organizationId:org,connectionId:cfg.connection_id,connectionVersion:cfg.connection_version,mailboxId:cfg.mailbox_id,email:cfg.sender_email,dailyLimit:cfg.mailbox_daily_limit})
 let receipt:DispatchOutcome={outcome:'rejected',code:'provider_mailbox_unavailable'}
 if(available){try{receipt=await deps.transport.send({organizationId:org,connectionId:cfg.connection_id,connectionVersion:cfg.connection_version,mailboxId:cfg.mailbox_id,claimToken:a.claim_token,message:a.message})}catch{receipt={outcome:'unknown',code:'transport_exception'}}}
 try{return {attemptId:a.id,receipt,settlement:await deps.repository.call(actor,org,'settle',{claimToken:a.claim_token,...receipt})}}catch{return {attemptId:a.id,receipt,outcome:'unknown',code:'receipt_persistence_failed'}}
}
