import { beforeAll,beforeEach,describe,expect,it } from 'vitest'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
const raw=process.env.WINNR_INGESTION_TEST_DATABASE_URL??''
function sql(source:string):Promise<{code:number;out:string;err:string}> {const u=new URL(raw);if(!['postgres:','postgresql:'].includes(u.protocol)||!['127.0.0.1','localhost'].includes(u.hostname)||u.port!=='55439'||u.pathname!=='/winnr_ingestion_test'||u.search)throw new Error('Unsafe ingestion fixture');const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('PG')));return new Promise(resolve=>{const c=execFile('psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-d',raw],{env,timeout:15000,maxBuffer:4000000},(error,out,err)=>resolve({code:error?1:0,out:out.trim(),err}));c.stdin?.end(source)})}
const org='11111111-1111-4111-8111-111111111111',other='11111111-1111-4111-8111-111111111112',actor='22222222-2222-4222-8222-222222222222',conn='33333333-3333-4333-8333-333333333333',account='44444444-4444-4444-8444-444444444444',lead='55555555-5555-4555-8555-555555555555',campaign='66666666-6666-4666-8666-666666666666',enrollment='77777777-7777-4777-8777-777777777777',attempt='88888888-8888-4888-8888-888888888888',endpoint='99999999-9999-4999-8999-999999999999'
const at='2026-10-05T00:00:00.000Z'
function event(type='email.received',id='evt_one',data:object={mailbox:'sender@example.test',from:'lead@example.test',subject:'Reply',message_id:'<incoming@example.test>',in_reply_to:'<provider@example.test>',received_at:at}) {return{id,object:'event',type,api_version:'2026-08',created:at,account_id:'acct_own',data}}
function receive(e=event(),endpointId=endpoint,channel='webhook'){return sql(`SELECT public.winnr_receive_event('${endpointId}','${JSON.stringify(e).replaceAll("'","''")}'::jsonb,'${'a'.repeat(64)}','${channel}');`)}
function accepted(){return sql(`INSERT INTO public.email_dispatch_attempts(id,organization_id,actor_id,campaign_id,enrollment_id,lead_id,account_id,connection_id,connection_version,mailbox_id,step_number,revision,sequence_snapshot,settings_snapshot,fingerprint,lease_expires_at,status,message,created_at,settled_at) VALUES('${attempt}','${org}','${actor}','${campaign}','${enrollment}','${lead}','${account}','${conn}',1,'provider-1',1,now(),'{}','{}','${'a'.repeat(64)}',now()+interval '10 minutes','accepted','{"messageId":"<original@example.test>","from":"sender@example.test","to":"lead@example.test","subject":"Outbound","text":"Original body"}',now(),now());INSERT INTO public.sent_emails(id,organization_id,campaign_id,campaign_lead_id,lead_id,email_account_id,to_email,from_email,subject,body_text,message_id) VALUES('${attempt}','${org}','${campaign}','${enrollment}','${lead}','${account}','lead@example.test','sender@example.test','Outbound','Original body','<original@example.test>');`)}
describe.skipIf(!raw)('Winnr durable ingestion PostgreSQL contract',()=>{
 beforeAll(async()=>{
  const contract=JSON.parse(readFileSync('tests/fixtures/live-schema-2026-10-05.json','utf8')) as {columns:{table_name:string;column_name:string;data_type:string;column_default:string|null;is_nullable:string}[];constraints:{table_name:string;conname:string;definition:string}[]}
  const tables=[...new Set(contract.columns.map(c=>c.table_name))]
  let fixture="DROP SCHEMA IF EXISTS public CASCADE;DROP SCHEMA IF EXISTS auth CASCADE;CREATE SCHEMA public;GRANT USAGE ON SCHEMA public TO PUBLIC;CREATE EXTENSION IF NOT EXISTS pgcrypto;CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\";CREATE SCHEMA IF NOT EXISTS auth;CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY);DO $$ BEGIN CREATE ROLE anon;EXCEPTION WHEN duplicate_object THEN NULL;END $$;DO $$ BEGIN CREATE ROLE authenticated;EXCEPTION WHEN duplicate_object THEN NULL;END $$;DO $$ BEGIN CREATE ROLE service_role;EXCEPTION WHEN duplicate_object THEN NULL;END $$;"
  for(const table of tables){const columns=contract.columns.filter(c=>c.table_name===table).map(c=>`"${c.column_name}" ${c.data_type}${c.column_default?` DEFAULT ${c.column_default}`:''}${c.is_nullable==='NO'?' NOT NULL':''}`);fixture+=`CREATE TABLE public."${table}"(${columns.join(',')});`}
  for(const c of [...contract.constraints].sort((a,b)=>Number(a.definition.startsWith('FOREIGN KEY'))-Number(b.definition.startsWith('FOREIGN KEY'))))fixture+=`ALTER TABLE public."${c.table_name}" ADD CONSTRAINT "${c.conname}" ${c.definition};`
  const base=await sql(fixture);expect(base.code,base.err).toBe(0)
  for(const file of ['020_winnr_connections.sql','021_outreach_event_spine.sql','023_outreach_suppression.sql','026_winnr_smtp.sql']){const r=await sql(readFileSync(`supabase/migrations/${file}`,'utf8'));expect(r.code,r.err).toBe(0)}
  const dispatchPath = 'supabase/migrations/024_email_dispatch.sql'
  const dispatch = await sql(readFileSync(dispatchPath,'utf8'))
  expect(dispatch.code,dispatch.err).toBe(0)
  const migration=await sql(readFileSync('supabase/migrations/027_winnr_ingestion.sql','utf8'));expect(migration.code,migration.err).toBe(0)
 })
 beforeEach(async()=>{const r=await sql(`TRUNCATE public.organizations,auth.users CASCADE;TRUNCATE public.email_dispatch_attempts;
 INSERT INTO public.organizations(id,name,slug) VALUES('${org}','Fixture','fixture'),('${other}','Other','other');INSERT INTO auth.users VALUES('${actor}');INSERT INTO public.users(id,email,organization_id,role) VALUES('${actor}','owner@example.test','${org}','owner');
 INSERT INTO public.winnr_connections(id,organization_id,provider_account_id,token_ciphertext,permissions) VALUES('${conn}','${org}','acct_own','encrypted','["read","write"]');
 INSERT INTO public.email_accounts(id,organization_id,email,provider) VALUES('${account}','${org}','sender@example.test','smtp');INSERT INTO public.winnr_mailbox_credentials(organization_id,connection_id,provider_mailbox_id,connection_version,email,account_id,credentials_ciphertext) VALUES('${org}','${conn}','provider-1',1,'sender@example.test','${account}','encrypted');
 INSERT INTO public.leads(id,organization_id,email) VALUES('${lead}','${org}','lead@example.test');INSERT INTO public.campaigns(id,organization_id,name) VALUES('${campaign}','${org}','Campaign');INSERT INTO public.campaign_leads(id,campaign_id,lead_id,status,next_send_at) VALUES('${enrollment}','${campaign}','${lead}','pending',now());
 INSERT INTO public.winnr_ingestion_endpoints(id,organization_id,connection_id,connection_version,provider_account_id,webhook_id,secret_ciphertext) VALUES('${endpoint}','${org}','${conn}',1,'acct_own','wh_one','encrypted');`);expect(r.code,r.err).toBe(0)})
 it('durably stops owned followups and saves body-pending reply/event/outbox atomically',async()=>{const r=await receive();expect(r.code,r.err).toBe(0);expect((await sql(`SELECT status||':'||(next_send_at IS NULL) FROM public.campaign_leads WHERE id='${enrollment}'`)).out).toBe('replied:true');expect((await sql('SELECT count(*) FROM public.replies WHERE body_text IS NULL')).out).toBe('1');expect((await sql('SELECT count(*) FROM public.outreach_outbox WHERE consumer=\'winnr.ingestion.body\'')).out).toBe('1')})
 it('dedupes repeated event and message identities, refusing conflicting payloads',async()=>{expect((await receive()).code).toBe(0);expect((await receive()).out).toContain('"duplicate": true');expect((await receive({...event(),data:{...event().data,subject:'Conflicting'}})).code).toBe(1);expect((await receive(event('email.received','evt_second'))).code).toBe(0);expect((await sql('SELECT count(*) FROM public.replies')).out).toBe('1')})
 it('reconciles late provider-ID mapping into one canonical incoming/outgoing timeline',async()=>{const sent=await accepted();expect(sent.code,sent.err).toBe(0);expect((await receive()).code).toBe(0);expect((await sql('SELECT count(*) FROM public.replies WHERE sent_email_id IS NOT NULL')).out).toBe('0');const map=event('message.relayed','evt_map',{original_message_id:'<original@example.test>',provider_message_id:'<provider@example.test>',recipient:'lead@example.test',sender:'sender@example.test'});const r=await receive(map);expect(r.code,r.err).toBe(0);expect((await receive(map)).code).toBe(0);expect((await sql(`SELECT count(*) FROM public.replies WHERE sent_email_id='${attempt}'`)).out).toBe('1');expect((await sql('SELECT count(*) FROM public.thread_messages WHERE direction=\'outbound\'')).out).toBe('1');expect((await sql('SELECT count(*) FROM public.thread_messages WHERE direction=\'inbound\'')).out).toBe('0');expect((await sql('SELECT message_count FROM public.threads')).out).toBe('2')})
 it('rejects account/foreign mailbox and stale connection with no partial receipt writes',async()=>{expect((await receive({...event(),account_id:'acct_other'})).code).toBe(1);expect((await receive(event('email.received','evt_foreign',{...event().data,mailbox:'foreign@example.test'}))).code).toBe(1);expect((await sql('SELECT count(*) FROM public.winnr_ingestion_receipts')).out).toBe('0');await sql(`UPDATE public.winnr_connections SET version=2 WHERE id='${conn}'`);expect((await receive()).code).toBe(1);expect((await sql('SELECT count(*) FROM public.replies')).out).toBe('0')})
 it('stores unknown sender without inventing a lead and atomically applies body optout',async()=>{expect((await receive(event('email.received','evt_unknown',{...event().data,from:'unknown@example.test',message_id:'<unknown@example.test>'}))).code).toBe(0);expect((await sql('SELECT count(*) FROM public.replies WHERE lead_id IS NULL')).out).toBe('1');expect((await receive()).code).toBe(0);const m=(await sql(`SELECT id FROM public.winnr_ingested_messages WHERE from_email='lead@example.test'`)).out;const r=await sql(`SELECT public.winnr_save_ingested_body('${actor}','${org}','${m}','123','unsubscribe',true,'${conn}',1)`);expect(r.code,r.err).toBe(0);expect((await sql('SELECT reason FROM public.outreach_suppressions')).out).toBe('unsubscribe');expect((await sql(`SELECT category FROM public.replies WHERE from_email='lead@example.test'`)).out).toBe('unsubscribe')})
 it('bounce and complaint share suppression transaction and prevent later followups',async()=>{const r=await receive(event('email.bounced','evt_bounce',{sender:'sender@example.test',recipient:'lead@example.test',bounce_type:'soft'}));expect(r.code,r.err).toBe(0);expect((await sql(`SELECT next_send_at IS NULL FROM public.campaign_leads`)).out).toBe('t');expect((await receive(event('email.complained','evt_complaint',{sender:'sender@example.test',recipient:'lead@example.test'}))).code).toBe(0);expect((await sql('SELECT reason FROM public.outreach_suppressions')).out).toBe('complaint')})
 it('handles mapping-before-reply and accepted settlement after the mapping',async()=>{
  const map=event('message.relayed','evt_map',{original_message_id:'<original@example.test>',provider_message_id:'<provider@example.test>',recipient:'lead@example.test',sender:'sender@example.test'})
  expect((await receive(map)).code).toBe(0);expect((await receive()).code).toBe(0)
  expect((await sql('SELECT count(*) FROM public.replies WHERE sent_email_id IS NOT NULL')).out).toBe('0')
  expect((await accepted()).code).toBe(0)
  const m=(await sql('SELECT id FROM public.winnr_ingested_messages')).out
  const r=await sql(`SELECT public.winnr_correlate_ingested('${org}','${m}')`);expect(r.code,r.err).toBe(0)
  expect((await sql(`SELECT count(*) FROM public.replies WHERE sent_email_id='${attempt}'`)).out).toBe('1')
 })
 it('does not correlate a provider mapping for a different recipient',async()=>{
  expect((await accepted()).code).toBe(0);expect((await receive()).code).toBe(0)
  expect((await receive(event('message.relayed','evt_other_map',{original_message_id:'<original@example.test>',provider_message_id:'<provider@example.test>',recipient:'foreign@example.test',sender:'sender@example.test'}))).code).toBe(0)
  expect((await sql('SELECT count(*) FROM public.replies WHERE sent_email_id IS NOT NULL')).out).toBe('0')
 })
 it('rolls back reply and stop when canonical outbox durability fails',async()=>{
  const setup=await sql("CREATE FUNCTION public.fixture_fail_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture durability failure'; END $$;CREATE TRIGGER fixture_fail BEFORE INSERT ON public.outreach_outbox FOR EACH ROW EXECUTE FUNCTION public.fixture_fail_outbox();");expect(setup.code,setup.err).toBe(0)
  try {expect((await receive()).code).toBe(1);expect((await sql('SELECT count(*) FROM public.replies')).out).toBe('0');expect((await sql('SELECT status FROM public.campaign_leads')).out).toBe('pending');expect((await sql('SELECT count(*) FROM public.winnr_ingestion_receipts')).out).toBe('0')}finally{await sql('DROP TRIGGER fixture_fail ON public.outreach_outbox;DROP FUNCTION public.fixture_fail_outbox();')}
 })
 it('denies browser access to secrets and write RPCs',async()=>{
  for(const role of ['anon','authenticated']) {expect((await sql(`SET ROLE ${role};SELECT secret_ciphertext FROM public.winnr_ingestion_endpoints`)).code).toBe(1);expect((await sql(`SET ROLE ${role};SELECT public.winnr_receive_event('${endpoint}','{}','${'a'.repeat(64)}')`)).code).toBe(1)}
 })

 it('serializes concurrent duplicate receipts through the dispatch organization lock',async()=>{
  const results=await Promise.all([receive(),receive()]);for(const result of results)expect(result.code,result.err).toBe(0)
  expect(results.filter(result=>result.out.includes('"duplicate": true'))).toHaveLength(1)
  expect((await sql('SELECT count(*) FROM public.replies')).out).toBe('1')
  expect((await sql('SELECT count(*) FROM public.winnr_ingestion_receipts')).out).toBe('1')
  expect((await sql('SELECT count(*) FROM public.outreach_outbox')).out).toBe('1')
 })

 it('disconnects after received/ping/map while retaining receipts, maps and canonical history',async()=>{
  expect((await receive()).code).toBe(0)
  expect((await receive(event('test.ping','evt_ping',{}))).code).toBe(0)
  expect((await receive(event('message.relayed','evt_map',{original_message_id:'<original@example.test>',provider_message_id:'<provider@example.test>',recipient:'lead@example.test',sender:'sender@example.test'}))).code).toBe(0)
  const result=await sql(`SELECT public.winnr_delete_connection('${org}','${conn}',1)`);expect(result.code,result.err).toBe(0);expect(result.out).toContain('deleted')
  expect((await sql('SELECT count(*) FROM public.winnr_ingestion_receipts')).out).toBe('3')
  expect((await sql('SELECT count(*) FROM public.winnr_message_id_maps')).out).toBe('1')
  expect((await sql('SELECT count(*) FROM public.replies')).out).toBe('1')
  expect((await receive(event('test.ping','evt_late',{}))).code).toBe(1)
 })
 it('rebinds a pending canonical message on current-version sync without duplicating reply',async()=>{
  expect((await receive()).code).toBe(0)
  const next='99999999-9999-4999-8999-999999999992'
  await sql(`UPDATE public.winnr_connections SET version=2 WHERE id='${conn}';UPDATE public.winnr_mailbox_credentials SET connection_version=2 WHERE connection_id='${conn}';INSERT INTO public.winnr_ingestion_endpoints(id,organization_id,connection_id,connection_version,provider_account_id,webhook_id,secret_ciphertext) VALUES('${next}','${org}','${conn}',2,'acct_own','wh_two','encrypted');`)
  expect((await receive(event('email.received','evt_rotated'),next,'sync')).code).toBe(0)
  expect((await sql('SELECT connection_version FROM public.winnr_ingested_messages')).out).toBe('2')
  const m=(await sql('SELECT id FROM public.winnr_ingested_messages')).out
  expect((await sql(`SELECT public.winnr_save_ingested_body('${actor}','${org}','${m}','123','Stale body',false,'${conn}',1)`)).code).toBe(1)
  const save=await sql(`SELECT public.winnr_save_ingested_body('${actor}','${org}','${m}','123','Recovered body',false,'${conn}',2)`);expect(save.code,save.err).toBe(0)
  expect((await sql('SELECT body_text FROM public.replies')).out).toBe('Recovered body')
  expect((await sql('SELECT count(*) FROM public.replies')).out).toBe('1')
  expect((await receive(event('test.ping','evt_old',{}))).code).toBe(1)
 })
 it('merges unknown threading header into the same reply and rejects conflicting known identity',async()=>{
  const data={mailbox:'sender@example.test',from:'lead@example.test',subject:'Reply',message_id:'<incoming@example.test>',received_at:at}
  expect((await receive(event('email.received','evt_minimal',data))).code).toBe(0)
  const enriched=await receive(event('email.received','evt_enriched',{...data,in_reply_to:'<provider@example.test>'}),endpoint,'sync');expect(enriched.code,enriched.err).toBe(0)
  expect((await sql('SELECT in_reply_to FROM public.replies')).out).toBe('<provider@example.test>')
  expect((await receive(event('email.received','evt_conflicting',{...data,in_reply_to:'<other@example.test>'}),endpoint,'sync')).code).toBe(1)
  expect((await receive(event('email.received','evt_identity',{...data,from:'foreign@example.test'}),endpoint,'sync')).code).toBe(1)
  expect((await sql('SELECT count(*) FROM public.replies')).out).toBe('1')
 })
 it('reconnects the same canonical account without duplicate reply/thread',async()=>{
  expect((await accepted()).code).toBe(0)
  expect((await receive()).code).toBe(0)
  expect((await receive(event('message.relayed','evt_before_disconnect_map',{original_message_id:'<original@example.test>',provider_message_id:'<provider@example.test>',recipient:'lead@example.test',sender:'sender@example.test'}))).code).toBe(0)
  const deleted=await sql(`SELECT public.winnr_delete_connection('${org}','${conn}',1)`);expect(deleted.code,deleted.err).toBe(0)
  const nextConn='33333333-3333-4333-8333-333333333334',nextEndpoint='99999999-9999-4999-8999-999999999992'
  const setup=await sql(`INSERT INTO public.winnr_connections(id,organization_id,provider_account_id,token_ciphertext) VALUES('${nextConn}','${org}','acct_own','encrypted');INSERT INTO public.winnr_mailbox_credentials(organization_id,connection_id,provider_mailbox_id,connection_version,email,account_id,credentials_ciphertext) VALUES('${org}','${nextConn}','provider-new',1,'sender@example.test','${account}','encrypted');INSERT INTO public.winnr_ingestion_endpoints(id,organization_id,connection_id,connection_version,provider_account_id,webhook_id,secret_ciphertext) VALUES('${nextEndpoint}','${org}','${nextConn}',1,'acct_own','wh_new','encrypted');`);expect(setup.code,setup.err).toBe(0)
  const synced=await receive(event('email.received','evt_reconnected'),nextEndpoint,'sync');expect(synced.code,synced.err).toBe(0)
  expect((await sql('SELECT count(*) FROM public.replies')).out).toBe('1');expect((await sql('SELECT count(*) FROM public.threads')).out).toBe('1')
  expect((await sql('SELECT connection_id FROM public.winnr_ingested_messages')).out).toBe(nextConn)
  expect((await sql('SELECT count(*) FROM public.thread_messages')).out).toBe('1')
  expect((await sql('SELECT sent_email_id FROM public.replies')).out).toBe(attempt)
 })

 it('requires a current verified association for service-only ingestion readiness',async()=>{
  expect((await sql(`SELECT public.winnr_ingestion_is_ready('${org}','${conn}',1)`)).out).toBe('f')
  const configured=await sql(`SELECT public.winnr_prepare_ingestion('${actor}','${org}','${conn}',1,'wh_verified','encrypted',ARRAY['email.received','message.relayed','email.bounced','email.complained'])`);expect(configured.code,configured.err).toBe(0)
  expect((await sql(`SELECT public.winnr_ingestion_is_ready('${org}','${conn}',1)`)).out).toBe('t')
  expect((await sql(`SELECT public.winnr_ingestion_is_ready('${other}','${conn}',1)`)).out).toBe('f')
  for(const role of ['anon','authenticated'])expect((await sql(`SET ROLE ${role};SELECT public.winnr_ingestion_is_ready('${org}','${conn}',1)`)).code).toBe(1)
  await sql(`UPDATE public.winnr_connections SET version=2 WHERE id='${conn}'`)
  expect((await sql(`SELECT public.winnr_ingestion_is_ready('${org}','${conn}',1)`)).out).toBe('f')
  expect((await sql(`SELECT public.winnr_ingestion_is_ready('${org}','${conn}',2)`)).out).toBe('f')
 })
 it('retains known headers when later metadata omits them and refuses provider-account identity mixing',async()=>{
  expect((await receive()).code).toBe(0)
  const data={mailbox:'sender@example.test',from:'lead@example.test',message_id:'<incoming@example.test>',received_at:at}
  expect((await receive(event('email.received','evt_missing_later',data),endpoint,'sync')).code).toBe(0)
  expect((await sql('SELECT in_reply_to FROM public.replies')).out).toBe('<provider@example.test>')
  const next='99999999-9999-4999-8999-999999999992'
  await sql(`UPDATE public.winnr_connections SET version=2,provider_account_id='acct_different' WHERE id='${conn}';UPDATE public.winnr_mailbox_credentials SET connection_version=2 WHERE connection_id='${conn}';INSERT INTO public.winnr_ingestion_endpoints(id,organization_id,connection_id,connection_version,provider_account_id,webhook_id,secret_ciphertext) VALUES('${next}','${org}','${conn}',2,'acct_different','wh_different','encrypted')`)
  expect((await receive({...event('email.received','evt_other_account'),account_id:'acct_different'},next,'sync')).code).toBe(1)
  expect((await sql('SELECT count(*) FROM public.replies')).out).toBe('1')
 })

})
