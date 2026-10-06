import { beforeAll,beforeEach,afterEach,describe,it,expect,vi } from 'vitest'
import { createHmac } from 'node:crypto'
import nodemailer from 'nodemailer'
import { NextRequest } from 'next/server'
import { z } from 'zod'
import { dispatchCampaign,authorizeEmailDispatchClaim,type DispatchRepository,type DispatchDeps } from '@/lib/outreach/dispatch'
import { sendManualReply,readReplyReadiness } from '@/lib/outreach/replies'
import { createWinnrSmtpTransport } from '@/lib/winnr/smtp-transport'
import { receiveWinnrEvent } from '@/lib/outreach/ingestion'
import { verifyUnsubscribeToken } from '@/lib/compliance/unsubscribe-token'
import { ids,sender,recipient,mailbox,fixtureSql,installFixture,seedFixture,localTlsMailSink,lit,json,MAIL_LOOP_ENV } from '../helpers/mail-loop-fixture'
const boundary=vi.hoisted(():{sql:(statement:string)=>string}=>({sql:():string=>{throw Error('Fixture not initialized')}}))
// Only substitute storage adapters: real route/token/suppression code executes against actual023 SQL.
vi.mock('@/lib/supabase/admin',()=>({createAdminClient:()=>({from:(table:string)=>{
 if(table!=='leads')throw Error('Unexpected fixture table');const filters:Record<string,string>={}
 const query={select:()=>query,eq:(field:string,value:string)=>{filters[field]=value;return query},limit:()=>query,single:async()=>({data:JSON.parse(boundary.sql(`SELECT coalesce((SELECT row_to_json(l) FROM public.leads l WHERE id='${filters.id?.replaceAll("'","''")}' AND organization_id='${filters.organization_id?.replaceAll("'","''")}'),'null'::json)`)),error:null})};return query
}})}))
vi.mock('@/lib/compliance/suppression-database',()=>({createSuppressionClient:()=>({rpc:async(name:string,p:Record<string,unknown>)=>{
 if(name!=='record_outreach_suppression')throw Error('Unexpected fixture RPC');const quote=(value:unknown)=>value==null?'NULL':`'${String(value).replaceAll("'","''")}'`
 return{data:boundary.sql(`SELECT public.record_outreach_suppression(${['p_organization_id','p_email','p_reason','p_source','p_notes','p_original_event_id','p_expires_at','p_lead_id'].map(key=>quote(p[key])).join(',')})`)==='t',error:null}
}})}))
import { POST as unsubscribe } from '@/app/unsubscribe/route'
let sink:Awaited<ReturnType<typeof localTlsMailSink>>
let factories=0,providerCreated=''
const resultSchema=z.object({attemptId:z.uuid(),receipt:z.object({outcome:z.enum(['accepted','rejected','unknown']),messageId:z.string().optional(),code:z.string().optional()}),settlement:z.object({status:z.string()})})
const parsed=(value:string):unknown=>JSON.parse(value)
function rpc(action:string,payload:Record<string,unknown>,reply=false):unknown{return parsed(fixtureSql(`SELECT public.${reply?'outreach_reply_mutate':'email_dispatch_mutate'}(${lit(ids.actor)},${lit(ids.org)},${lit(action)},${json(payload)})`))}
function repository(reply=false,afterReserve?:()=>void):DispatchRepository{return{call:async(actor,org,action,payload)=>{
 expect(actor).toBe(ids.actor);expect(org).toBe(ids.org);const result=rpc(action,payload,reply);if(action==='reserve'&&z.object({allowed:z.boolean().optional()}).parse(result).allowed)afterReserve?.();return result
}}}
function deps(reply=false,afterReserve?:()=>void):DispatchDeps{
 const shared=repository();return{repository:repository(reply,afterReserve),appUrl:'https://fixture.example',mailboxAvailable:async input=>input.mailboxId===mailbox&&input.email===sender,
 transport:createWinnrSmtpTransport({sendTimeoutMs:3000,loadCredentials:async input=>{
 expect(input).toMatchObject({organizationId:ids.org,connectionId:ids.connection,connectionVersion:1,mailboxId:mailbox})
 return{providerMailboxId:mailbox,domain:'example.test',fromEmail:sender,fromName:'Fixture',smtpHost:'smtp.fixture.test',smtpPort:465,smtpUsername:sender,smtpPassword:'synthetic-password',imapHost:'imap.fixture.test',imapPort:993,imapUsername:sender,imapPassword:'synthetic-password',footer:''}},
 resolve:async()=>[{address:'8.8.8.8',family:4}],authorizeClaim:input=>authorizeEmailDispatchClaim(shared,ids.actor,input),createTransport:options=>{
 factories++;expect(options).toMatchObject({host:'8.8.8.8',port:465,secure:true,pool:false,tls:{servername:'smtp.fixture.test',rejectUnauthorized:true,minVersion:'TLSv1.2'},disableFileAccess:true,disableUrlAccess:true})
 // Endpoint routing and a fixture CA are the only substituted SMTP dependencies.
 // Actual Nodemailer connects/authenticates/sends MIME over verified local TLS.
 return nodemailer.createTransport({...options,host:'127.0.0.1',port:sink.port,tls:{...options.tls,ca:sink.ca}})
 }})}
}
async function signedEvent(type:'email.received'|'message.relayed',data:Record<string,unknown>,eventId='evt_fixture_inbound',valid=true){
 const endpointId=fixtureSql('SELECT id FROM public.winnr_ingestion_endpoints');const secret='whsec_synthetic_fixture_only'
 const event={id:eventId,object:'event',api_version:'2026-08',type,created:providerCreated,account_id:'fixture-provider-account',data};const raw=Buffer.from(JSON.stringify(event));const timestamp=String(Math.floor(Date.now()/1000));const signature='v1='+createHmac('sha256',secret).update(`${timestamp}.`).update(raw).digest('hex')
 return receiveWinnrEvent(endpointId,raw,{timestamp,signature:valid?signature:'v1='+ '0'.repeat(64),eventId,eventType:type},{endpoint:async()=>({id:endpointId,organizationId:ids.org,connectionId:ids.connection,connectionVersion:1,providerAccountId:'fixture-provider-account',secret}),persist:async(endpoint,payload,fingerprint)=>z.object({duplicate:z.boolean(),eventId:z.string()}).parse(parsed(fixtureSql(`SELECT public.winnr_receive_event(${lit(endpoint.id)},${json(payload)},${lit(fingerprint)})`)))})
}
function header(data:string,name:string):string{const value=data.replace(/\r\n[ \t]+/g,'').match(new RegExp(`^${name}:[ \t]*(.+)$`,'mi'))?.[1];if(!value)throw Error(`Missing MIME header ${name}`);return value.trim()}
describe.skipIf(!process.env[MAIL_LOOP_ENV])('controlled real TLS SMTP mail loop + actual020–032 ledger',()=>{
 beforeAll(()=>{installFixture();boundary.sql=fixtureSql})
 beforeEach(async()=>{seedFixture();factories=0;providerCreated=new Date().toISOString();vi.stubEnv('ENCRYPTION_SECRET','synthetic-mail-loop-only');sink=await localTlsMailSink();const configured=z.object({configured:z.boolean()}).parse(rpc('configure',{campaignId:ids.campaign,senderName:'Fixture Sender',senderCompany:'Fixture Company',businessAddress:'Provided fixture address',senderEmail:sender,mailboxId:mailbox,mailboxDailyLimit:10}));expect(configured.configured).toBe(true);expect(z.object({ready:z.boolean()}).parse(rpc('start',{campaignId:ids.campaign})).ready).toBe(true)})
 afterEach(async()=>{await sink?.close();vi.unstubAllEnvs()})
 it('SMTP DATA → canonical receipt → authenticated reply stop → one real human reply → signed HTTP opt-out',async()=>{
  const sent=await dispatchCampaign(ids.actor,ids.org,ids.campaign,1,deps());const first=resultSchema.parse(sent.outcomes[0]);expect(first.receipt.outcome).toBe('accepted');expect(first.settlement.status).toBe('accepted')
  expect(sink.messages).toHaveLength(1);expect(sink.protocols).toHaveLength(1);expect(sink.protocols[0]).toMatch(/^TLSv1\.[23]$/);expect(sink.commands.some(line=>line.startsWith('AUTH PLAIN'))).toBe(true);expect(sink.commands.filter(line=>line==='DATA')).toHaveLength(1);expect(sink.messages[0]).toMatchObject({from:sender,to:[recipient]})
  const mail=sink.messages[0];if(!mail)throw Error('Missing sink mail');const messageId=header(mail.data,'Message-ID');expect(first.receipt.messageId).toBe(messageId);expect(mail.data).toContain('Controlled SMTP body');expect(mail.data).toContain('Provided fixture address');expect(header(mail.data,'List-Unsubscribe-Post')).toBe('List-Unsubscribe=One-Click')
  expect(fixtureSql(`SELECT message_id FROM public.sent_emails WHERE id=${lit(first.attemptId)}`)).toBe(messageId)
  expect(fixtureSql(`SELECT current_step FROM public.campaign_leads WHERE id=${lit(ids.enrollment)}`)).toBe('1')
  const inbound={mailbox:sender,from:recipient,to:sender,subject:'Question',message_id:'<inbound-fixture@example.test>',in_reply_to:messageId}
  await expect(signedEvent('email.received',inbound,'evt_invalid_signature',false)).rejects.toThrow('Invalid webhook signature');expect(fixtureSql('SELECT count(*) FROM public.replies')).toBe('0')
  expect((await signedEvent('email.received',inbound)).duplicate).toBe(false);expect((await signedEvent('email.received',inbound)).duplicate).toBe(true)
  expect(fixtureSql(`SELECT status||':'||(next_send_at IS NULL) FROM public.campaign_leads WHERE id=${lit(ids.enrollment)}`)).toBe('replied:true');expect(fixtureSql("SELECT body_status FROM public.winnr_ingested_messages")).toBe('pending')
  await dispatchCampaign(ids.actor,ids.org,ids.campaign,1,deps());expect(sink.messages).toHaveLength(1)
  fixtureSql(`SELECT public.winnr_save_ingested_body(${lit(ids.actor)},${lit(ids.org)},id,'123','A real fixture question',false,${lit(ids.connection)},1) FROM public.winnr_ingested_messages`)
  const threadId=fixtureSql('SELECT thread_id FROM public.replies'),repo=repository(true);const initial=await readReplyReadiness(repo,ids.actor,ids.org,threadId)
  rpc('control',{threadId,mode:'human',expectedRevision:initial.control?.revision},true);const ready=await readReplyReadiness(repo,ids.actor,ids.org,threadId);if(!ready.sourceReplyId||!ready.controlRevision)throw Error('No pinned reply context')
  const input={message:'Human SMTP reply',sourceReplyId:ready.sourceReplyId,controlRevision:ready.controlRevision};const reply=await sendManualReply(ids.actor,ids.org,threadId,input,deps(true));expect(reply.accepted).toBe(true)
  expect(sink.messages).toHaveLength(2);const replyMail=sink.messages[1];if(!replyMail)throw Error('Missing manual sink mail');expect(header(replyMail.data,'In-Reply-To')).toBe(inbound.message_id);if(reply.receipt.outcome!=='accepted')throw Error('Manual SMTP not accepted');expect(header(replyMail.data,'Message-ID')).toBe(reply.receipt.messageId)
  await expect(sendManualReply(ids.actor,ids.org,threadId,input,deps(true))).rejects.toThrow('response_already_reserved');expect(sink.messages).toHaveLength(2);expect(fixtureSql('SELECT count(*) FROM public.thread_messages')).toBe('2')
  const link=header(mail.data,'List-Unsubscribe').replace(/^<|>$/g,'');const token=new URL(link).searchParams.get('token');if(!token)throw Error('Missing signed optout');expect(verifyUnsubscribeToken(token)).toMatchObject({workspaceId:ids.org,leadId:ids.lead,campaignId:ids.campaign})
  for(let i=0;i<2;i++)expect((await unsubscribe(new NextRequest(link,{method:'POST',body:'List-Unsubscribe=One-Click',headers:{'Content-Type':'application/x-www-form-urlencoded'}}))).status).toBe(200)
  expect(fixtureSql('SELECT normalized_email||\':\'||reason FROM public.outreach_suppressions')).toBe(`${recipient}:unsubscribe`);expect(fixtureSql('SELECT count(*) FROM public.outreach_suppressions')).toBe('1');expect(fixtureSql(`SELECT status FROM public.leads WHERE id=${lit(ids.lead)}`)).toBe('unsubscribed');expect(sink.messages).toHaveLength(2)
 })
 it.each(['suppression','master-stop'])('%s committed after reservation prevents any SMTP connection',async(stop)=>{
  const sent=await dispatchCampaign(ids.actor,ids.org,ids.campaign,1,deps(false,()=>fixtureSql(stop==='suppression'?`SELECT public.record_outreach_suppression(${lit(ids.org)},${lit(recipient)},'unsubscribe','fixture')`:`SELECT public.outreach_operations_mutate(${lit(ids.actor)},${lit(ids.org)},'stop','{"expectedRevision":1}')`)))
  const outcome=resultSchema.parse(sent.outcomes[0]);expect(outcome.receipt.outcome).toBe('rejected');expect(outcome.settlement.status).toBe('cancelled');expect(factories).toBe(0);expect(sink.connections).toBe(0);expect(sink.messages).toHaveLength(0);expect(fixtureSql('SELECT count(*) FROM public.email_dispatch_attempts WHERE authorized_at IS NOT NULL')).toBe('0')
 })
 it('sink receives DATA but drops the receipt: durable unknown holds until exact signed relay reconciles once',async()=>{
  sink.dropAfterData=true;const sent=await dispatchCampaign(ids.actor,ids.org,ids.campaign,1,deps());const a=resultSchema.parse(sent.outcomes[0]);expect(a.receipt.outcome).toBe('unknown');expect(a.settlement.status).toBe('unknown');expect(sink.messages).toHaveLength(1);expect(fixtureSql('SELECT count(*) FROM public.sent_emails')).toBe('0')
  const mail=sink.messages[0];if(!mail)throw Error('Missing ambiguous sink DATA');const messageId=header(mail.data,'Message-ID');await dispatchCampaign(ids.actor,ids.org,ids.campaign,1,deps());expect(sink.messages).toHaveLength(1);expect(factories).toBe(1)
  await signedEvent('message.relayed',{sender,recipient,original_message_id:messageId,provider_message_id:'<fixture-provider-relay@example.test>',relayed_at:new Date().toISOString()},'evt_fixture_relay')
  const reconcile=()=>z.object({status:z.string(),alreadyAccepted:z.boolean().optional()}).parse(parsed(fixtureSql(`SELECT public.outreach_reconciliation_mutate(${lit(ids.actor)},${lit(ids.org)},'reconcile',${json({attemptId:a.attemptId})})`)))
  expect(reconcile().status).toBe('accepted');expect(reconcile().alreadyAccepted).toBe(true);expect(fixtureSql(`SELECT current_step FROM public.campaign_leads WHERE id=${lit(ids.enrollment)}`)).toBe('1');expect(fixtureSql('SELECT count(*) FROM public.sent_emails')).toBe('1');expect(fixtureSql('SELECT count(*) FROM public.outreach_reconciliation_audit')).toBe('1');expect(sink.messages).toHaveLength(1)
 })
})
