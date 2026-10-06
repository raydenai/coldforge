import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createUnsubscribeToken } from '@/lib/compliance/unsubscribe-token'
import { configurationSchema,dispatchMessageSchema,fingerprintDispatchMessage,type DispatchDeps,type DispatchMessage,type DispatchRepository,type DispatchOutcome } from './dispatch'
import { WinnrApiError } from '@/lib/winnr/server'
export const replyInputSchema=z.object({message:z.string().trim().min(1).max(20000),sourceReplyId:z.uuid(),controlRevision:z.number().int().positive(),senderProfileId:z.uuid().optional()}).strict()
export const replyContextSchema=z.object({threadId:z.uuid(),sourceReplyId:z.uuid(),controlRevision:z.number().int().positive(),recipient:z.email(),leadId:z.uuid(),subject:z.string(),inReplyTo:z.string().regex(/^<[^<>\s@]+@[^<>\s@]+>$/),configuration:configurationSchema})
export type ReplyContext=z.infer<typeof replyContextSchema>
export type ReplySource='human'|'agent'|'closebot'
export interface PreparedReply {readonly context:ReplyContext;readonly message:DispatchMessage;readonly fingerprint:string}
const escape=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;')
export function renderReply(context:ReplyContext,body:string,appUrl:string):DispatchMessage {
 const c=replyContextSchema.parse(context),cfg=c.configuration
 const text=z.string().trim().min(1).max(20000).parse(body)
 const origin=new URL(appUrl);if(origin.protocol!=='https:'||origin.username||origin.password)throw new WinnrApiError(503,'service_unavailable','HTTPS application origin required')
 const link=new URL('/unsubscribe',origin);link.searchParams.set('token',createUnsubscribeToken({leadId:c.leadId,campaignId:cfg.campaign_id,workspaceId:cfg.organization_id}))
 const footer=`${cfg.sender_name}\n${cfg.sender_company}\n${cfg.business_address}\nUnsubscribe: ${link.href}`
 return dispatchMessageSchema.parse({from:cfg.sender_email,to:c.recipient,subject:/^re:/i.test(c.subject)?c.subject:`Re: ${c.subject}`,text:`${text}\n\n${footer}`,html:`<p>${escape(text).replaceAll('\n','<br>')}</p><hr><p>${escape(footer).replaceAll('\n','<br>')}</p>`,messageId:`<${randomUUID()}@${cfg.sender_email.split('@')[1]}>`,inReplyTo:c.inReplyTo,references:[c.inReplyTo],headers:{'List-Unsubscribe':`<${link.href}>`,'List-Unsubscribe-Post':'List-Unsubscribe=One-Click'}})
}
/** Prepare once before approval; execute this exact Message-ID/content after030 approves its fingerprint. */
export function prepareReply(context:ReplyContext,body:string,appUrl:string):PreparedReply {const message=renderReply(context,body,appUrl);return {context:replyContextSchema.parse(context),message,fingerprint:fingerprintDispatchMessage(message)}}
export async function readReplyReadiness(repository:DispatchRepository,actor:string,org:string,threadId:string,senderProfileId?:string){
 return z.object({ready:z.boolean(),reason:z.string().nullish(),control:z.object({mode:z.enum(['human','assist','autonomous']),revision:z.number().int()}).optional(),threadId:z.uuid().optional(),sourceReplyId:z.uuid().optional(),controlRevision:z.number().optional(),recipient:z.email().optional(),leadId:z.uuid().optional(),subject:z.string().optional(),inReplyTo:z.string().optional(),configuration:configurationSchema.optional(),mailbox:z.object({connectionId:z.uuid(),connectionVersion:z.number().int(),providerMailboxId:z.string(),email:z.email()}).optional()}).parse(await repository.call(actor,org,'readiness',{threadId,senderProfileId}))
}
export async function executePreparedReply(actor:string,org:string,prepared:PreparedReply,source:ReplySource,decisionId:string|undefined,deps:DispatchDeps){
 const c=replyContextSchema.parse(prepared.context),message=dispatchMessageSchema.parse(prepared.message)
 if(c.configuration.organization_id!==org||fingerprintDispatchMessage(message)!==prepared.fingerprint)throw new WinnrApiError(409,'conflict','Prepared reply changed')
 const cfg=c.configuration
 if(!await deps.mailboxAvailable({organizationId:org,connectionId:cfg.connection_id,connectionVersion:cfg.connection_version,mailboxId:cfg.mailbox_id,email:cfg.sender_email,dailyLimit:cfg.mailbox_daily_limit}))throw new WinnrApiError(503,'service_unavailable','Provider mailbox unavailable')
 const reservation=z.object({allowed:z.boolean().optional(),ready:z.boolean().optional(),reason:z.string().optional(),attempt:z.object({id:z.uuid(),claim_token:z.uuid()}).optional()}).parse(await deps.repository.call(actor,org,'reserve',{...c,senderProfileId:cfg.campaign_id,source,decisionId,message,fingerprint:prepared.fingerprint}))
 if(!reservation.allowed||!reservation.attempt)throw new WinnrApiError(409,'conflict',reservation.reason??'Reply was not reserved')
 const a=reservation.attempt,input={organizationId:org,connectionId:cfg.connection_id,connectionVersion:cfg.connection_version,mailboxId:cfg.mailbox_id,claimToken:a.claim_token,message}
 let receipt:DispatchOutcome
 try{receipt=await deps.transport.send(input)}catch{receipt={outcome:'unknown',code:'transport_exception'}}
 try{
  const settlement=z.object({settled:z.boolean(),status:z.string()}).parse(await deps.repository.call(actor,org,'settle',{claimToken:a.claim_token,...receipt}))
  return{attemptId:a.id,receipt,settlement,accepted:settlement.settled&&settlement.status==='accepted',deliveryEvidence:'smtp_acceptance_only'}
 }catch{return{attemptId:a.id,receipt,accepted:false,outcome:'unknown',code:'receipt_persistence_failed',deliveryEvidence:'unknown'}}
}
export async function sendManualReply(actor:string,org:string,threadId:string,raw:unknown,deps:DispatchDeps){
 const input=replyInputSchema.parse(raw),readiness=await readReplyReadiness(deps.repository,actor,org,threadId,input.senderProfileId)
 if(!readiness.ready)throw new WinnrApiError(409,'conflict',readiness.reason??'Reply setup required')
 const context=replyContextSchema.parse(readiness)
 if(context.sourceReplyId!==input.sourceReplyId||context.controlRevision!==input.controlRevision)throw new WinnrApiError(409,'conflict','Conversation changed; reload before replying')
 return executePreparedReply(actor,org,prepareReply(context,input.message,deps.appUrl),'human',undefined,deps)
}
