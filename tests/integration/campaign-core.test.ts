import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'

const raw = process.env.OUTREACH_CAMPAIGN_TEST_DATABASE_URL ?? ''
function sql(source: string): Promise<{ code: number; out: string; err: string }> {
  const url = new URL(raw)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== '55439' || url.pathname !== '/campaign_core_test' || url.search) throw new Error('Unsafe campaign fixture URL')
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('PG')))
  return new Promise(resolve => {
    const child = execFile('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', raw], { env, timeout: 15000 }, (error, out, err) => resolve({ code: error ? 1 : 0, out: out.trim(), err }))
    child.stdin?.end(source)
  })
}
const org = '11111111-1111-4111-8111-111111111111'
const otherOrg = '11111111-1111-4111-8111-111111111112'
const actor = '22222222-2222-4222-8222-222222222222'
const member = '22222222-2222-4222-8222-222222222223'
const campaign = '33333333-3333-4333-8333-333333333333'
const lead = '44444444-4444-4444-8444-444444444444'
const foreignLead = '44444444-4444-4444-8444-444444444445'
function mutate(operation: string, payload: object = {}, user = actor, organization = org, revision: string | null = null) {
  return sql(`SELECT public.campaign_core_mutate('${user}','${organization}','${campaign}','${operation}','${JSON.stringify(payload).replaceAll("'", "''")}'::jsonb,${revision ? "'" + revision + "'::timestamptz" : 'NULL'});`)
}

describe.skipIf(!raw)('campaign core real PostgreSQL', () => {
  beforeAll(async () => {
    const fixture = await sql(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      CREATE TABLE IF NOT EXISTS public.organizations(id uuid PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS public.users(id uuid PRIMARY KEY, organization_id uuid REFERENCES public.organizations, role text);
      CREATE TABLE IF NOT EXISTS public.lead_lists(id uuid PRIMARY KEY, organization_id uuid);
      CREATE TABLE IF NOT EXISTS public.leads(id uuid PRIMARY KEY, organization_id uuid, list_id uuid, email text, validation_status text);
      CREATE TABLE IF NOT EXISTS public.campaigns(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,name text NOT NULL,status text DEFAULT 'draft',settings jsonb,stats jsonb,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE TABLE IF NOT EXISTS public.campaign_sequences(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),campaign_id uuid REFERENCES public.campaigns ON DELETE CASCADE,step_number integer NOT NULL,subject text NOT NULL,body_html text NOT NULL,body_text text,delay_days integer,delay_hours integer,condition_type text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      CREATE TABLE IF NOT EXISTS public.campaign_leads(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),campaign_id uuid REFERENCES public.campaigns ON DELETE CASCADE,lead_id uuid REFERENCES public.leads,status text,current_step integer,created_at timestamptz DEFAULT now(),last_sent_at timestamptz,next_send_at timestamptz);
      CREATE TABLE IF NOT EXISTS public.winnr_connections(id uuid PRIMARY KEY,organization_id uuid,version integer);
    `)
    expect(fixture.code, fixture.err).toBe(0)
    const migration = await sql(readFileSync('supabase/migrations/022_campaign_core.sql', 'utf8'))
    expect(migration.code, migration.err).toBe(0)
  })
  beforeEach(async () => {
    const r = await sql(`TRUNCATE public.campaign_leads,public.campaign_sequences,public.campaigns,public.leads,public.lead_lists,public.users,public.organizations CASCADE;
      INSERT INTO public.organizations VALUES('${org}'),('${otherOrg}');
      INSERT INTO public.users VALUES('${actor}','${org}','owner'),('${member}','${org}','member');
      INSERT INTO public.campaigns(id,organization_id,name,status,settings,stats,updated_at) VALUES('${campaign}','${org}','Offer','draft','{}','{}','2026-10-05T00:00:00Z');
      INSERT INTO public.leads VALUES('${lead}','${org}',NULL,'valid@example.test','valid'),('${foreignLead}','${otherOrg}',NULL,'foreign@example.test','valid');
      INSERT INTO public.campaign_sequences(campaign_id,step_number,subject,body_html,body_text) VALUES('${campaign}',1,'Original','','Original plain text');`)
    expect(r.code, r.err).toBe(0)
  })
  it('rejects foreign tenant and member writes', async () => {
    expect((await mutate('pause', {}, actor, otherOrg)).code).toBe(1)
    expect((await mutate('settings', { settings: {} }, member)).code).toBe(1)
  })
  it('rolls back a failed sequence replacement and retains body text', async () => {
    const result = await mutate('sequence', { steps: [{ step_number: 1, subject: null, body_html: '', body_text: 'Replacement' }] }, actor, org, '2026-10-05T00:00:00Z')
    expect(result.code).toBe(1)
    expect((await sql(`SELECT subject||':'||body_text FROM public.campaign_sequences WHERE campaign_id='${campaign}'`)).out).toBe('Original:Original plain text')
  })
  it('replaces sequences atomically and rejects a stale writer', async () => {
    const payload = { steps: [{ step_number: 1, subject: 'Replacement', body_html: '<p>HTML</p>', body_text: 'Plain', delay_days: 2, delay_hours: 1, condition_type: 'always' }] }
    expect((await mutate('sequence', payload, actor, org, '2026-10-05T00:00:00Z')).code).toBe(0)
    expect((await mutate('sequence', payload, actor, org, '2026-10-05T00:00:00Z')).code).toBe(1)
    expect((await sql(`SELECT body_html||':'||body_text FROM public.campaign_sequences WHERE campaign_id='${campaign}'`)).out).toBe('<p>HTML</p>:Plain')
  })
  it('allows exactly one simultaneous editor at the same revision', async () => {
    const payload = { steps: [{ step_number: 1, subject: 'Concurrent', body_html: '', body_text: 'Plain', delay_days: 0, delay_hours: 0, condition_type: 'always' }] }
    const results = await Promise.all([mutate('sequence', payload, actor, org, '2026-10-05T00:00:00Z'), mutate('sequence', payload, actor, org, '2026-10-05T00:00:00Z')])
    expect(results.map(result => result.code).sort()).toEqual([0, 1])
    expect((await sql(`SELECT count(*) FROM public.campaign_sequences WHERE campaign_id='${campaign}'`)).out).toBe('1')
  })

  it('enrolls valid own leads once and rejects foreign leads without partial insertion', async () => {
    expect((await mutate('enroll', { leadIds: [lead, foreignLead] })).code).toBe(1)
    expect((await sql('SELECT count(*) FROM public.campaign_leads')).out).toBe('0')
    expect((await mutate('enroll', { leadIds: [lead, lead] })).code).toBe(0)
    expect((await mutate('enroll', { leadIds: [lead] })).code).toBe(0)
    expect((await sql('SELECT count(*) FROM public.campaign_leads')).out).toBe('1')
  })
  it('blocks start honestly, pauses active campaigns, and prevents active edits', async () => {
    expect((await mutate('start')).code).toBe(1)
    await sql(`UPDATE public.campaigns SET status='active' WHERE id='${campaign}'`)
    expect((await mutate('sequence', { steps: [] }, actor, org, '2026-10-05T00:00:00Z')).code).toBe(1)
    expect((await mutate('pause')).code).toBe(0)
    expect((await mutate('pause')).code).toBe(1)
    expect((await sql(`SELECT status FROM public.campaigns WHERE id='${campaign}'`)).out).toBe('paused')
  })
  it('denies direct anonymous and authenticated execution of service functions', async () => {
    expect((await sql(`SET ROLE authenticated; SELECT public.campaign_core_mutate('${actor}','${org}','${campaign}','start','{}',NULL);`)).code).toBe(1)
  })
})
