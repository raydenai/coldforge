import { lookup } from 'node:dns/promises'
import type { WinnrAuthContext } from '@/lib/winnr/server'
import { createWinnrSmtpRepository } from '@/lib/winnr/smtp-database'
import { createWinnrSmtpTransport } from '@/lib/winnr/smtp-transport'
import { createEmailDispatchDeps } from './dispatch-runtime'
import { createReplyRepository } from './replies-database'
import { authorizeEmailDispatchClaim,type DispatchDeps } from './dispatch'

// Legacy relative budgets used when no absolute deadline is supplied.
const LEGACY_AUTH_MS=15000
const LEGACY_MAILBOX_MS=3000
const LEGACY_CREDENTIAL_MS=3000
const LEGACY_DNS_MS=2000
const LEGACY_SEND_MS=10000
// Absolute-deadline budgets: leave the receipt RPC a tail and never authorize
// a handoff without a usable slice of effect time.
const RECEIPT_RESERVE_MS=4000
const MIN_HANDOFF_MS=1000
const MAX_SEND_MS=10000

async function bounded<T>(work:Promise<T>,milliseconds:number):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([work,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Reply preflight deadline')),milliseconds)})])}finally{clearTimeout(timer)}}

/**
 * Reply-phase dependency ports.
 *
 * Optional absolute `deadlineAt` (epoch ms) is the caller's request budget.
 * When it is supplied every awaited boundary is bounded by the actual
 * remaining time: repository RPCs, mailbox preflight, credential read, DNS,
 * the single-use grant and the SMTP send timeout; enough time is held back for
 * the receipt tail and a grant is refused before any socket could be created.
 * With no deadline the historical relative budgets are unchanged.
 *
 * Every SMTP handoff starts before 15s legacy / the effect deadline, SMTP is
 * capped at 10s, receipt storage is capped at 4s. One effect only.
 */
export function createReplyDeps(actor:WinnrAuthContext,startedAt=Date.now(),deadlineAt?:number):DispatchDeps {
 const started=startedAt
 const storage=deadlineAt===undefined?createWinnrSmtpRepository():createWinnrSmtpRepository({deadlineAt})
 const authRepository=createReplyRepository(true,deadlineAt)
 const repository=createReplyRepository(false,deadlineAt)

 if(deadlineAt===undefined){
  // Exact legacy path: no absolute deadline, relative preflight budgets only.
  const base=createEmailDispatchDeps(actor)
  return {repository,appUrl:base.appUrl,
   mailboxAvailable:input=>bounded(base.mailboxAvailable(input),LEGACY_MAILBOX_MS).catch(()=>false),
   transport:createWinnrSmtpTransport({sendTimeoutMs:LEGACY_SEND_MS,loadCredentials:input=>bounded(storage.loadCredentials(input),LEGACY_CREDENTIAL_MS),resolve:hostname=>bounded(lookup(hostname,{all:true}),LEGACY_DNS_MS),authorizeClaim:async input=>{
    if(Date.now()-started>LEGACY_AUTH_MS)return null
    const grant=await authorizeEmailDispatchClaim(authRepository,actor.userId,input)
    return Date.now()-started<=LEGACY_AUTH_MS?grant:null
   }})
  }
 }

 // Absolute path: the effect deadline holds back the receipt tail, so the
 // grant/socket can never consume the budget the receipt RPC still needs.
 const effectDeadline=deadlineAt-RECEIPT_RESERVE_MS
 const remainingToEffect=()=>effectDeadline-Date.now()
 const base=createEmailDispatchDeps(actor,effectDeadline)
 return {repository,appUrl:base.appUrl,
  mailboxAvailable:input=>{
   if(remainingToEffect()<=0)return Promise.resolve(false)
   // Actual abort: the mailbox provider is created with a signal derived from
   // this effect deadline, so an in-flight read cannot outlive it.
   return base.mailboxAvailable(input)
  },
  transport:createWinnrSmtpTransport({
   get sendTimeoutMs(){return Math.max(1,Math.min(MAX_SEND_MS,remainingToEffect()))},
   loadCredentials:input=>storage.loadCredentials(input),
   resolve:hostname=>{
    const left=remainingToEffect()
    // DNS lookup is read-only and uncancellable; it may settle later, but the
    // grant below still refuses once the effect deadline has passed, so a late
    // DNS answer can never authorize or open a socket.
    if(left<=0)return Promise.reject(new Error('Reply DNS deadline exceeded'))
    return bounded(lookup(hostname,{all:true}),Math.min(LEGACY_DNS_MS,left))
   },
   authorizeClaim:async input=>{
    if(remainingToEffect()<MIN_HANDOFF_MS)return null
    const grant=await authorizeEmailDispatchClaim(authRepository,actor.userId,input)
    return remainingToEffect()>=MIN_HANDOFF_MS?grant:null
   }})
 }
}
