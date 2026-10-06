/** Disposable PostgreSQL proof for migration023; never accepts an ambient database. */
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
const url = process.env.SUPPRESSION_TEST_DATABASE_URL
const PSQL = process.env.PSQL ?? 'psql'
function sql(statement: string) {
  if (!url) throw new Error('Missing explicit fixture URL')
  const parsed = new URL(url)
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || parsed.hostname !== '127.0.0.1' || parsed.port !== '55439' || parsed.pathname !== '/coldforge_suppression_test' || parsed.search) throw new Error('Unsafe suppression fixture URL')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')))
  return execFileSync(PSQL, ['-X', '-v', 'ON_ERROR_STOP=1', '--dbname', url, '-At'], { input: statement, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
}
const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222', lead = '33333333-3333-4333-8333-333333333333'
const record = (org = a, email = ' Person@Example.com ', reason = 'unsubscribe', id = 'NULL') => `SELECT public.record_outreach_suppression('${org}','${email}','${reason}','fixture',NULL,NULL,NULL,${id});`
describe.skipIf(!url)('migration023 real PostgreSQL contract', () => {
  beforeAll(() => {
    sql(`DROP TABLE IF EXISTS public.outreach_suppressions, public.campaign_leads, public.campaigns, public.leads, public.organizations CASCADE;
DROP FUNCTION IF EXISTS public.record_outreach_suppression(uuid,text,text,text,text,text,timestamptz,uuid);
CREATE TABLE public.organizations(id uuid PRIMARY KEY);
CREATE TABLE public.leads(id uuid PRIMARY KEY,organization_id uuid REFERENCES public.organizations,email text,status text,updated_at timestamptz);
CREATE TABLE public.campaigns(id uuid PRIMARY KEY,organization_id uuid REFERENCES public.organizations);
CREATE TABLE public.campaign_leads(campaign_id uuid REFERENCES public.campaigns,lead_id uuid REFERENCES public.leads,status text,next_send_at timestamptz);
INSERT INTO public.organizations VALUES ('${a}'),('${b}');
INSERT INTO public.leads VALUES ('${lead}','${a}','Person@Example.com','active',now()),('33333333-3333-4333-8333-333333333334','${b}','person@example.com','active',now());
INSERT INTO public.campaigns VALUES ('44444444-4444-4444-8444-444444444444','${a}'),('44444444-4444-4444-8444-444444444445','${b}');
INSERT INTO public.campaign_leads SELECT c.id,l.id,'pending',now() FROM public.campaigns c JOIN public.leads l ON l.organization_id=c.organization_id;`)
    sql(readFileSync('supabase/migrations/023_outreach_suppression.sql','utf8'))
  })
  it('atomically normalizes and stops matching organization leads and enrollment', () => {
    expect(sql(record(a, ' Person@Example.com ', 'unsubscribe', `'${lead}'`))).toBe('t')
    expect(sql(`SELECT normalized_email||':'||reason FROM public.outreach_suppressions`)).toBe('person@example.com:unsubscribe')
    expect(sql(`SELECT status FROM public.leads WHERE organization_id='${a}'`)).toBe('unsubscribed')
    expect(sql(`SELECT status||':'||(next_send_at IS NULL) FROM public.campaign_leads cl JOIN public.campaigns c ON c.id=cl.campaign_id WHERE c.organization_id='${a}'`)).toBe('unsubscribed:true')
    expect(sql(`SELECT status FROM public.leads WHERE organization_id='${b}'`)).toBe('active')
  })
  it('is idempotent and never downgrades complaint', () => {
    sql(record()); sql(record(a,'person@example.com','complaint')); sql(record())
    expect(sql('SELECT count(*) FROM public.outreach_suppressions')).toBe('1')
    expect(sql('SELECT reason FROM public.outreach_suppressions')).toBe('complaint')
  })
  it('rejects foreign lead references without writing', () => {
    expect(() => sql(record(b,'person@example.com','unsubscribe',`'${lead}'`))).toThrow()
    expect(sql(`SELECT count(*) FROM public.outreach_suppressions WHERE organization_id='${b}'`)).toBe('0')
  })
  it.each(['bad address@example.com','person@@example.com','a..b@example.com','.person@example.com','person.@example.com'])('rejects ambiguous malformed address %s', email => { expect(() => sql(record(a,email))).toThrow() })
  it('denies browser reads/writes and RPC while granting only service entry points', () => {
    expect(sql("SELECT has_table_privilege('authenticated','public.outreach_suppressions','INSERT') OR has_table_privilege('anon','public.outreach_suppressions','SELECT') OR has_table_privilege('service_role','public.outreach_suppressions','UPDATE')")).toBe('f')
    expect(sql("SELECT has_function_privilege('authenticated','public.record_outreach_suppression(uuid,text,text,text,text,text,timestamptz,uuid)','EXECUTE')")).toBe('f')
    expect(sql("SELECT has_function_privilege('service_role','public.record_outreach_suppression(uuid,text,text,text,text,text,timestamptz,uuid)','EXECUTE')")).toBe('t')
  })
  it('rejects oversized source metadata', () => { expect(() => sql(`SELECT public.record_outreach_suppression('${a}','person@example.com','unsubscribe',repeat('x',101));`)).toThrow() })
})
