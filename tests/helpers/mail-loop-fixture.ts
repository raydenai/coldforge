import { createServer,type TLSSocket } from 'node:tls'
import { execFileSync } from 'node:child_process'
import { mkdtempSync,readFileSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { requireSafeFixtureUrl,runSql,strippedEnv } from './postgres-fixture'
export const MAIL_LOOP_ENV='OUTREACH_MAIL_LOOP_TEST_DATABASE_URL'
export const MAIL_LOOP_DATABASE='outreach_mail_loop_test'
export const ids={org:'11111111-1111-4111-8111-111111111111',actor:'22222222-2222-4222-8222-222222222222',campaign:'33333333-3333-4333-8333-333333333333',lead:'44444444-4444-4444-8444-444444444444',enrollment:'55555555-5555-4555-8555-555555555555',connection:'66666666-6666-4666-8666-666666666666',account:'77777777-7777-4777-8777-777777777777',evidence:'88888888-8888-4888-8888-888888888888'}
export const sender='sender@example.test',recipient='lead@example.test',mailbox='fixture-mailbox'
export function lit(value:unknown):string{return value==null?'NULL':`'${String(value).replaceAll("'","''")}'`}
export const json=(value:unknown)=>`${lit(JSON.stringify(value))}::jsonb`
export function fixtureSql(statement:string):string{return runSql(requireSafeFixtureUrl(MAIL_LOOP_ENV,MAIL_LOOP_DATABASE).url,statement)}
export function installFixture(){
 fixtureSql(`DROP SCHEMA IF EXISTS public CASCADE;DROP SCHEMA IF EXISTS auth CASCADE;CREATE SCHEMA public;GRANT USAGE ON SCHEMA public TO PUBLIC;CREATE SCHEMA auth;
 DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon;END IF;IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated;END IF;IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role;END IF;END $$;
 CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,raw_user_meta_data jsonb);
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;`)
 fixtureSql(readFileSync('tests/fixtures/baseline-outreach.sql','utf8'));fixtureSql(readFileSync('supabase/migrations/002_rls_policies.sql','utf8'))
 for(const file of ['020_winnr_connections.sql','021_outreach_event_spine.sql','022_campaign_core.sql','023_outreach_suppression.sql','024_email_dispatch.sql','025_identity_bootstrap.sql','026_winnr_smtp.sql','027_winnr_ingestion.sql','028_lead_validation.sql','029_email_replies.sql','030_outreach_agents.sql','031_outreach_operations.sql','032_outreach_reconciliation.sql'])fixtureSql(readFileSync(`supabase/migrations/${file}`,'utf8'))
}
export function seedFixture(){
 fixtureSql(`TRUNCATE public.organizations,auth.users CASCADE;
 INSERT INTO public.organizations(id,name,slug) VALUES(${lit(ids.org)},'Mail fixture','mail-fixture');INSERT INTO auth.users(id,email) VALUES(${lit(ids.actor)},'owner@example.test');INSERT INTO public.users(id,email,organization_id,role) VALUES(${lit(ids.actor)},'owner@example.test',${lit(ids.org)},'owner');
 INSERT INTO public.email_accounts(id,organization_id,email,provider) VALUES(${lit(ids.account)},${lit(ids.org)},${lit(sender)},'smtp');
 INSERT INTO public.winnr_connections(id,organization_id,provider_account_id,token_ciphertext,permissions) VALUES(${lit(ids.connection)},${lit(ids.org)},'fixture-provider-account','synthetic','["read","write"]');
 INSERT INTO public.winnr_mailbox_credentials(organization_id,connection_id,connection_version,provider_mailbox_id,email,account_id,credentials_ciphertext) VALUES(${lit(ids.org)},${lit(ids.connection)},1,${lit(mailbox)},${lit(sender)},${lit(ids.account)},'synthetic');
 SELECT public.winnr_prepare_ingestion(${lit(ids.actor)},${lit(ids.org)},${lit(ids.connection)},1,'fixture-webhook','synthetic',ARRAY['email.received','message.relayed','email.bounced','email.complained']);
 INSERT INTO public.leads(id,organization_id,email,first_name) VALUES(${lit(ids.lead)},${lit(ids.org)},${lit(recipient)},'Fixture');
 INSERT INTO public.campaigns(id,organization_id,name,status,settings) VALUES(${lit(ids.campaign)},${lit(ids.org)},'Mail loop','draft',${json({timezone:'UTC',sendingWindowStart:0,sendingWindowEnd:24,skipWeekends:false,dailyLimit:10,mailboxIds:[mailbox],senderConnectionId:ids.connection,senderConnectionVersion:1})});
 INSERT INTO public.campaign_leads(id,campaign_id,lead_id,status,current_step) VALUES(${lit(ids.enrollment)},${lit(ids.campaign)},${lit(ids.lead)},'pending',0);
 INSERT INTO public.campaign_sequences(campaign_id,step_number,subject,body_html,body_text,condition_type,delay_days,delay_hours) VALUES(${lit(ids.campaign)},1,'Hello {{firstName}}','','Controlled SMTP body','always',0,0),(${lit(ids.campaign)},2,'Follow up','','Follow up body','not_replied',0,0);
 SELECT public.lead_validation_reserve_operation(${lit(ids.evidence)},${lit(ids.actor)},${lit(ids.org)},${lit(ids.lead)},'zerobounce');
 SELECT public.lead_validation_finalize_provider(${lit(ids.evidence)},${lit(ids.actor)},${lit(ids.org)},${lit(ids.lead)},'zerobounce',${lit(recipient)},'valid','deliverable','synthetic-fixture-proof',now());`)
}
export interface SinkMail {data:string;from:string;to:string[]}
export async function localTlsMailSink(){
 const directory=mkdtempSync(path.join(tmpdir(),'coldforge-local-smtp-'))
 const key=path.join(directory,'key.pem'),cert=path.join(directory,'cert.pem')
 execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=smtp.fixture.test','-addext','subjectAltName=DNS:smtp.fixture.test'],{env:strippedEnv(),stdio:'ignore'})
 const ca=readFileSync(cert),sockets=new Set<TLSSocket>(),messages:SinkMail[]=[],commands:string[]=[],protocols:string[]=[]
 let connections=0,dropAfterData=false
 const server=createServer({key:readFileSync(key),cert:ca,minVersion:'TLSv1.2'},socket=>{
  connections++;const protocol=socket.getProtocol();if(protocol)protocols.push(protocol);sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.on('error',()=>{});socket.setEncoding('utf8');socket.write('220 fixture SMTP\r\n')
  let buffer='',inData=false,from='',to:string[]=[]
  socket.on('data',chunk=>{
   buffer+=String(chunk)
   while(buffer.length){
    if(inData){const end=buffer.indexOf('\r\n.\r\n');if(end<0)return;messages.push({data:buffer.slice(0,end).replace(/\r\n\.\./g,'\r\n.'),from,to:[...to]});buffer=buffer.slice(end+5);inData=false;if(dropAfterData){socket.destroy();return}socket.write('250 2.0.0 accepted locally\r\n');continue}
    const end=buffer.indexOf('\r\n');if(end<0)return;const line=buffer.slice(0,end);buffer=buffer.slice(end+2);commands.push(line)
    if(/^EHLO|^HELO/i.test(line))socket.write('250-fixture\r\n250-AUTH PLAIN\r\n250 SIZE 1000000\r\n')
    else if(/^AUTH PLAIN/i.test(line))socket.write('235 2.7.0 fixture authentication\r\n')
    else if(/^MAIL FROM:/i.test(line)){from=line.slice(10).replace(/[<>]/g,'');to=[];socket.write('250 sender accepted\r\n')}
    else if(/^RCPT TO:/i.test(line)){to.push(line.slice(8).replace(/[<>]/g,''));socket.write('250 recipient accepted\r\n')}
    else if(/^DATA$/i.test(line)){inData=true;socket.write('354 End with dot\r\n')}
    else if(/^QUIT$/i.test(line))socket.end('221 Bye\r\n')
    else if(/^RSET|^NOOP/i.test(line))socket.write('250 OK\r\n')
    else socket.write('500 unsupported fixture command\r\n')
   }
  })
 })
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve())})
 const address=server.address();if(!address||typeof address==='string')throw Error('Missing local sink port')
 return{ca,port:address.port,messages,commands,protocols,get connections(){return connections},set dropAfterData(value:boolean){dropAfterData=value},async close(){for(const socket of sockets)socket.destroy();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));rmSync(directory,{recursive:true,force:true})}}
}
