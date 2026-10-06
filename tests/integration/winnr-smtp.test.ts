import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
const raw = process.env.WINNR_SMTP_TEST_DATABASE_URL ?? ''
function sql(source: string): Promise<{ code: number; out: string; err: string }> {
  const url = new URL(raw)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1','localhost'].includes(url.hostname) || url.port !== '55439' || url.pathname !== '/winnr_smtp_test' || url.search) throw new Error('Unsafe SMTP fixture URL')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')))
  return new Promise(resolve => {
    const child = execFile('psql', ['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-d',raw], { env, timeout: 15000 }, (error,out,err) => resolve({ code: error ? 1 : 0, out: out.trim(), err }))
    child.stdin?.end(source)
  })
}
const org = '11111111-1111-4111-8111-111111111111'
const other = '11111111-1111-4111-8111-111111111112'
const actor = '22222222-2222-4222-8222-222222222222'
const member = '22222222-2222-4222-8222-222222222223'
const conn = '33333333-3333-4333-8333-333333333333'
const row = { providerMailboxId: 'provider-1', email: 'sender@example.test', displayName: 'Sender', ciphertext: 'private-encrypted-ciphertext' }
function persist(rows: object[] = [row], version = 1, user = actor, organization = org) {
  return sql(`SELECT public.winnr_sync_smtp_credentials('${user}','${organization}','${conn}',${version},'${JSON.stringify(rows).replaceAll("'","''")}'::jsonb);`)
}
describe.skipIf(!raw)('private Winnr SMTP PostgreSQL contract', () => {
  beforeAll(async () => {
    const fixture = await sql(`CREATE EXTENSION IF NOT EXISTS pgcrypto;
      DO $$ BEGIN CREATE ROLE service_role; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      CREATE TABLE IF NOT EXISTS public.organizations(id uuid PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS public.users(id uuid PRIMARY KEY,organization_id uuid,role text);
      CREATE TABLE IF NOT EXISTS public.winnr_connections(id uuid PRIMARY KEY,organization_id uuid,version integer);
      CREATE TABLE IF NOT EXISTS public.email_accounts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,email text NOT NULL,display_name text,provider text NOT NULL,status text DEFAULT 'active',smtp_host text,smtp_port integer,smtp_username text,smtp_password_encrypted text,imap_host text,imap_port integer,oauth_tokens_encrypted jsonb,daily_limit integer DEFAULT 50,sent_today integer DEFAULT 0,warmup_enabled boolean DEFAULT false,warmup_progress integer DEFAULT 0,health_score integer DEFAULT 100,last_error text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
      ALTER TABLE public.email_accounts ALTER COLUMN email SET NOT NULL, ALTER COLUMN provider SET NOT NULL, ALTER COLUMN status SET DEFAULT 'active';
      DO $$ BEGIN ALTER TABLE public.email_accounts ADD CONSTRAINT email_accounts_provider_check CHECK(provider IN ('google','microsoft','smtp')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN ALTER TABLE public.email_accounts ADD CONSTRAINT email_accounts_status_check CHECK(status IN ('active','paused','error','warming')); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    `)
    expect(fixture.code,fixture.err).toBe(0)
    const source = readFileSync('supabase/migrations/026_winnr_smtp.sql','utf8')
    expect((await sql(source)).code).toBe(0)
    expect((await sql(source)).code).toBe(0)
  })
  beforeEach(async () => {
    const result = await sql(`TRUNCATE public.winnr_mailbox_credentials,public.email_accounts,public.winnr_connections,public.users,public.organizations CASCADE;
      INSERT INTO public.organizations VALUES('${org}'),('${other}');
      INSERT INTO public.users VALUES('${actor}','${org}','owner'),('${member}','${org}','member');
      INSERT INTO public.winnr_connections VALUES('${conn}','${org}',1);`)
    expect(result.code,result.err).toBe(0)
  })
  it('stores private ciphertext and returns only metadata with stable account binding', async () => {
    const first = await persist(); expect(first.code,first.err).toBe(0)
    expect(first.out).not.toContain('ciphertext')
    expect((await sql('SELECT credentials_ciphertext FROM public.winnr_mailbox_credentials')).out).toBe(row.ciphertext)
    expect((await sql('SET ROLE service_role; SELECT credentials_ciphertext FROM public.winnr_mailbox_credentials')).out).toBe(row.ciphertext)
    const account = (await sql('SELECT account_id FROM public.winnr_mailbox_credentials')).out
    expect((await persist([{ ...row, ciphertext: 'new-encrypted-value' }])).code).toBe(0)
    expect((await sql('SELECT account_id FROM public.winnr_mailbox_credentials')).out).toBe(account)
    expect((await sql('SELECT count(*) FROM public.email_accounts WHERE smtp_password_encrypted IS NOT NULL OR oauth_tokens_encrypted IS NOT NULL')).out).toBe('0')
  })
  it('rejects cross-organization and member imports with no credential/account writes', async () => {
    expect((await persist([row],1,actor,other)).code).toBe(1)
    expect((await persist([row],1,member)).code).toBe(1)
    expect((await sql('SELECT count(*) FROM public.winnr_mailbox_credentials')).out).toBe('0')
    expect((await sql('SELECT count(*) FROM public.email_accounts')).out).toBe('0')
  })
  it('checks connection version atomically and preserves credentials after a stale import', async () => {
    expect((await persist()).code).toBe(0)
    await sql(`UPDATE public.winnr_connections SET version=2 WHERE id='${conn}'`)
    expect((await persist([{ ...row, ciphertext: 'stale-replacement' }])).code).toBe(1)
    expect((await sql('SELECT credentials_ciphertext FROM public.winnr_mailbox_credentials')).out).toBe(row.ciphertext)
  })
  it('rolls back every account/credential when a later row is malformed or duplicated', async () => {
    expect((await persist([row,{ ...row,providerMailboxId: 'provider-2',email: 'other@example.test',ciphertext: '' }])).code).toBe(1)
    expect((await sql('SELECT count(*) FROM public.email_accounts')).out).toBe('0')
    expect((await persist([row,row])).code).toBe(1)
    expect((await sql('SELECT count(*) FROM public.winnr_mailbox_credentials')).out).toBe('0')
  })
  it('denies authenticated and anonymous access to private table and import function', async () => {
    for (const role of ['anon','authenticated']) {
      expect((await sql(`SET ROLE ${role}; SELECT credentials_ciphertext FROM public.winnr_mailbox_credentials`)).code).toBe(1)
      expect((await sql(`SET ROLE ${role}; SELECT public.winnr_sync_smtp_credentials('${actor}','${org}','${conn}',1,'[]');`)).code).toBe(1)
    }
  })
})
