import { lookup } from 'node:dns/promises'
import { z } from 'zod'
import { buildWinnrDeps } from '@/app/api/winnr/_shared'
import { listMailboxes, WinnrApiError, type WinnrAuthContext } from '@/lib/winnr/server'
import { createWinnrSmtpRepository } from '@/lib/winnr/smtp-database'
import { createWinnrSmtpTransport } from '@/lib/winnr/smtp-transport'
import { createEmailDispatchRepository } from './dispatch-database'
import { authorizeEmailDispatchClaim, configurationSchema, renderDispatchMessage, stepSchema, type DispatchDeps } from './dispatch'
/** Legacy relative preflight cutoff when no absolute request deadline is supplied. */
const LEGACY_PREFLIGHT_MS=17000
export function createEmailDispatchDeps(actor:WinnrAuthContext,deadlineAt?:number):DispatchDeps {
 const started=Date.now()
 const repository=createEmailDispatchRepository(deadlineAt===undefined?{}:{deadlineAt})
 const storage=createWinnrSmtpRepository(deadlineAt===undefined?{}:{deadlineAt})
 const remaining=()=>deadlineAt===undefined?LEGACY_PREFLIGHT_MS-(Date.now()-started):deadlineAt-Date.now()
 const expired=()=>remaining()<=0
 const mailboxSignal=()=>{
  if(deadlineAt===undefined)return undefined
  const left=remaining()
  return left<=0?AbortSignal.abort():AbortSignal.timeout(Math.max(1,left))
 }
 return {repository,appUrl:process.env.NEXT_PUBLIC_APP_URL??'',transport:createWinnrSmtpTransport({loadCredentials:storage.loadCredentials,get sendTimeoutMs(){const left=remaining();return deadlineAt===undefined?10000:Math.max(1000,Math.min(10000,left))},resolve:deadlineAt===undefined?undefined:async host=>{
    const left=remaining();if(left<=0)throw new Error('SMTP DNS deadline exceeded')
    let timer:ReturnType<typeof setTimeout>|undefined
    try{return await Promise.race([lookup(host,{all:true,verbatim:true}),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('SMTP DNS deadline exceeded')),left)})])}finally{clearTimeout(timer)}
   },authorizeClaim:async input=>{
    if(expired())return null
    const grant=await authorizeEmailDispatchClaim(repository,actor.userId,input)
    return expired()?null:grant
   }}),
  async mailboxAvailable(input){
   // Fail closed before constructing a provider if the budget is already gone.
   if(deadlineAt!==undefined&&expired())return false
   // The provider is created with a signal derived from the request deadline,
   // so an in-flight mailbox read is actually aborted instead of only being
   // checked before/after each page.
   const deps=buildWinnrDeps(deadlineAt===undefined?{}:{signal:mailboxSignal(),deadlineAt});let cursor:string|undefined
   for(let i=0;i<10;i++){
    if(deadlineAt!==undefined&&expired())return false
    const page=await listMailboxes(actor,deps,{cursor,limit:100})
    if(page.connectionId!==input.connectionId||page.connectionVersion!==input.connectionVersion)return false
    const mailbox=page.items.find(m=>m.id===input.mailboxId)
    if(mailbox)return mailbox.status==='active'&&mailbox.email.trim().toLowerCase()===input.email&&mailbox.dailyLimit!==null&&input.dailyLimit<=mailbox.dailyLimit
    if(!page.hasMore)return false;cursor=page.nextCursor??undefined
   }return false
  }}
}
export async function readEmailDispatchReadiness(actor:WinnrAuthContext,campaignId:string,deps:DispatchDeps) {
 const result=z.object({ready:z.boolean(),reason:z.string().optional(),configuration:configurationSchema.optional(),steps:z.array(stepSchema).optional()}).parse(await deps.repository.call(actor.userId,actor.organizationId,'readiness',{campaignId}))
 if(!result.ready||!result.configuration)return {...result,warmupReadiness:'unknown'}
 const cfg=result.configuration
 // Validate sender identity/footer/token/appURL and template vocabulary before activation.
 for(const step of result.steps??[])renderDispatchMessage({enrollmentId:campaignId,lead:{id:campaignId,email:'validation@example.com',first_name:'Required',last_name:'Required',company:'Required',title:'Required'},step,configuration:cfg},deps.appUrl)
 const available=await deps.mailboxAvailable({organizationId:actor.organizationId,connectionId:cfg.connection_id,connectionVersion:cfg.connection_version,mailboxId:cfg.mailbox_id,email:cfg.sender_email,dailyLimit:cfg.mailbox_daily_limit})
 return {ready:available,reason:available?undefined:'provider_mailbox_unavailable',configuration:cfg,warmupReadiness:'unknown',deliveryEvidence:'not_yet_measured'}
}
export async function activateEmailCampaign(actor:WinnrAuthContext,campaignId:string,action:'start'|'resume',deps:DispatchDeps) {
 const readiness=await readEmailDispatchReadiness(actor,campaignId,deps)
 if(!readiness.ready)throw new WinnrApiError(503,'service_unavailable',readiness.reason??'Email dispatch configuration is incomplete')
 const result=z.object({ready:z.boolean(),reason:z.string().optional(),campaign:z.unknown().optional()}).parse(await deps.repository.call(actor.userId,actor.organizationId,action,{campaignId}))
 if(!result.ready)throw new WinnrApiError(503,'service_unavailable',result.reason??'Sender readiness changed')
 return {success:true,status:'active',campaign:result.campaign,warmupReadiness:'unknown'}
}
