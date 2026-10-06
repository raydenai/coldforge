/**
 * Shard 031 PostgreSQL proof: install the exact committed baseline plus every
 * additive outreach migration 020 → 031 on the owned disposable database
 * `outreach_operations_test`, then exercise the real operations RPCs, the
 * master outbound stop at the shared send gate, lease fencing, fairness, tenant
 * authority and the honest attention read.
 *
 * Safety: the only target is `OUTREACH_OPERATIONS_TEST_DATABASE_URL` pointing at
 * postgres://127.0.0.1:55439/outreach_operations_test. libpq PG* variables are
 * stripped by the shared fixture helper; no production URL is ever consulted.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { psqlExecutable, requireSafeFixtureUrl, runSql, runSqlResult, strippedEnv } from '../helpers/postgres-fixture'

const ENV_NAME = 'OUTREACH_OPERATIONS_TEST_DATABASE_URL'
const DATABASE = 'outreach_operations_test'

const rawUrl = process.env[ENV_NAME]
const fixture = rawUrl ? requireSafeFixtureUrl(ENV_NAME, DATABASE) : null
const url = fixture?.url

const baselineSql = readFileSync('tests/fixtures/baseline-outreach.sql', 'utf8')
const legacyRlsSql = readFileSync('supabase/migrations/002_rls_policies.sql', 'utf8')

const ADDITIVE_MIGRATIONS = [
  '020_winnr_connections.sql',
  '021_outreach_event_spine.sql',
  '022_campaign_core.sql',
  '023_outreach_suppression.sql',
  '024_email_dispatch.sql',
  '025_identity_bootstrap.sql',
  '026_winnr_smtp.sql',
  '027_winnr_ingestion.sql',
  '028_lead_validation.sql',
  '029_email_replies.sql',
  '030_outreach_agents.sql',
  '031_outreach_operations.sql',
]

const ids = {
  org: '11111111-1111-4111-8111-111111111111',
  otherOrg: '11111111-1111-4111-8111-111111111112',
  emptyOrg: '11111111-1111-4111-8111-111111111113',
  owner: '22222222-2222-4222-8222-222222222222',
  otherOwner: '22222222-2222-4222-8222-222222222224',
  member: '22222222-2222-4222-8222-222222222223',
  campaign: '33333333-3333-4333-8333-333333333333',
  lead: '44444444-4444-4444-8444-444444444444',
  enrollment: '55555555-5555-4555-8555-555555555555',
  connection: '66666666-6666-4666-8666-666666666666',
  account: '77777777-7777-4777-8777-777777777777',
}
const SENDER = 'sender@example.com'
const MAILBOX = 'provider-mailbox'
const TOKEN_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TOKEN_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const TOKEN_3 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const VERIFIED_EVENTS = "ARRAY['email.received','message.relayed','email.bounced','email.complained']"

function sql(statement: string): string {
  return runSql(url as string, statement)
}
function lit(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}
function json(value: unknown): string {
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`
}
function parseJson<T>(output: string): T {
  return JSON.parse(output) as T
}
function mutate(action: string, payload: Record<string, unknown> = {}, actor = ids.owner): Record<string, unknown> {
  return parseJson<Record<string, unknown>>(
    sql(`SELECT public.outreach_operations_mutate(${lit(actor)},${lit(ids.org)},${lit(action)},${json(payload)});`),
  )
}
function claim(token: string, org: string | null): Record<string, unknown> {
  return parseJson<Record<string, unknown>>(
    sql(`SELECT public.outreach_operations_claim(${lit(token)},25,${org ? `${lit(org)}::uuid` : 'NULL'});`),
  )
}

/** Minimal interactive psql session for true cross-connection concurrency. */
interface PsqlSession {
  send(statement: string): void
  waitFor(marker: string, timeoutMs?: number): Promise<string>
  end(): void
}
function openPsqlSession(): PsqlSession {
  const child: ChildProcess = spawn(psqlExecutable(), ['-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '--dbname', url as string], {
    env: strippedEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let buffer = ''
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => { buffer += chunk })
  child.stderr?.on('data', (chunk: string) => { buffer += chunk })
  return {
    send(statement: string) {
      child.stdin?.write(statement.endsWith('\n') ? statement : `${statement}\n`)
    },
    async waitFor(marker: string, timeoutMs = 5000): Promise<string> {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (buffer.includes(marker)) return buffer
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error(`timed out waiting for ${marker}; output=${buffer}`)
    },
    end() {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    },
  }
}

async function waitForUngrantedAdvisoryLocks(expected: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const count = Number(sql("SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND NOT granted;"))
    if (count >= expected) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${expected} queued advisory locks`)
}
function seed(): void {
  sql(`
TRUNCATE public.outreach_operations_runs, public.outreach_operations_leases, public.outreach_operations_heartbeats,
  public.outreach_operations_control, public.outreach_agent_decisions, public.outreach_agent_runs,
  public.outreach_agent_drafts, public.outreach_agent_policies, public.outreach_offer_briefs, public.outreach_agent_models,
  public.outreach_conversation_controls, public.email_dispatch_attempts, public.email_dispatch_config,
  public.lead_validation_operations, public.lead_validation_evidence, public.winnr_message_id_maps,
  public.winnr_ingested_messages, public.winnr_ingestion_receipts, public.winnr_ingestion_endpoints,
  public.winnr_mailbox_credentials, public.winnr_operations, public.winnr_connections,
  public.outreach_outbox, public.outreach_events, public.outreach_suppressions, public.thread_messages,
  public.threads, public.replies, public.sent_emails, public.campaign_leads, public.campaign_sequences,
  public.campaigns, public.leads, public.email_accounts, public.lead_lists, public.domains, public.warmup_emails,
  public.users, public.organizations, auth.users CASCADE;
INSERT INTO public.organizations(id,name,slug,plan) VALUES
  (${lit(ids.org)},'Ops Fixture','ops-fixture','starter'),
  (${lit(ids.otherOrg)},'Other Fixture','other-fixture','starter'),
  (${lit(ids.emptyOrg)},'Empty Fixture','empty-fixture','starter');
INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES
  (${lit(ids.owner)},'owner@example.com','{}'::jsonb),
  (${lit(ids.otherOwner)},'other-owner@example.com','{}'::jsonb),
  (${lit(ids.member)},'member@example.com','{}'::jsonb);
INSERT INTO public.users(id,organization_id,email,role) VALUES
  (${lit(ids.owner)},${lit(ids.org)},'owner@example.com','owner'),
  (${lit(ids.otherOwner)},${lit(ids.otherOrg)},'other-owner@example.com','owner'),
  (${lit(ids.member)},${lit(ids.org)},'member@example.com','member');
INSERT INTO public.email_accounts(id,organization_id,email,provider,status) VALUES(${lit(ids.account)},${lit(ids.org)},${lit(SENDER)},'smtp','active');
INSERT INTO public.winnr_connections(id,organization_id,provider_account_id,token_ciphertext,version) VALUES(${lit(ids.connection)},${lit(ids.org)},'winnr-acct','ciphertext',1);
INSERT INTO public.winnr_mailbox_credentials(organization_id,connection_id,provider_mailbox_id,connection_version,email,account_id,credentials_ciphertext)
  VALUES(${lit(ids.org)},${lit(ids.connection)},${lit(MAILBOX)},1,${lit(SENDER)},${lit(ids.account)},'mailbox-ciphertext');
INSERT INTO public.campaigns(id,organization_id,name,status,settings,stats,updated_at)
  VALUES(${lit(ids.campaign)},${lit(ids.org)},'Ops Campaign','active','{}'::jsonb,'{}'::jsonb,now());
INSERT INTO public.leads(id,organization_id,email,status) VALUES(${lit(ids.lead)},${lit(ids.org)},'lead@example.com','active');
INSERT INTO public.campaign_leads(id,campaign_id,lead_id,status,current_step) VALUES(${lit(ids.enrollment)},${lit(ids.campaign)},${lit(ids.lead)},'pending',0);
INSERT INTO public.campaign_sequences(campaign_id,step_number,subject,body_html,body_text,condition_type,delay_days,delay_hours)
  VALUES(${lit(ids.campaign)},1,'Step','','Body','always',0,0);
`)
}

const KNOWN_FUNCTIONS = [
  'public.outreach_operations_claim(uuid,integer,uuid)',
  'public.outreach_operations_settle(uuid,text,uuid,timestamp with time zone,text,text,uuid,uuid,uuid,text,integer,integer)',
  'public.outreach_operations_mutate(uuid,uuid,text,jsonb)',
  'public.outreach_operations_readiness(uuid)',
  'public.outreach_operations_outbound_stopped(uuid)',
  'public.email_dispatch_mutate(uuid,uuid,text,jsonb)',
  'public.email_dispatch_mutate_029(uuid,uuid,text,jsonb)',
  'public.outreach_reply_mutate_029(uuid,uuid,text,jsonb)',
]

describe.skipIf(!url)('shard 031 operations over the 020→031 baseline', () => {
  beforeAll(() => {
    sql(`
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
DROP SCHEMA IF EXISTS auth CASCADE;
CREATE SCHEMA auth;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE TABLE auth.users(id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb);
CREATE EXTENSION IF NOT EXISTS pgcrypto;
`)
    expect(runSqlResult(url as string, baselineSql).code).toBe(0)
    expect(runSqlResult(url as string, legacyRlsSql).code).toBe(0)
    for (const file of ADDITIVE_MIGRATIONS) {
      const result = runSqlResult(url as string, readFileSync(`supabase/migrations/${file}`, 'utf8'))
      expect(result.code, `${file}: ${result.err}`).toBe(0)
    }
  })

  beforeEach(() => seed())

  it('installs every 031 function and keeps 029 private', () => {
    for (const signature of KNOWN_FUNCTIONS) {
      expect(sql(`SELECT to_regprocedure(${lit(signature)}) IS NOT NULL;`), signature).toBe('t')
    }
    expect(sql("SELECT has_function_privilege('service_role','public.email_dispatch_mutate_029(uuid,uuid,text,jsonb)','EXECUTE');")).toBe('f')
    expect(sql("SELECT has_function_privilege('service_role','public.outreach_reply_mutate_029(uuid,uuid,text,jsonb)','EXECUTE');")).toBe('f')
    expect(sql("SELECT has_function_privilege('service_role','public.outreach_operations_claim(uuid,integer,uuid)','EXECUTE');")).toBe('t')
  })

  it('defaults automation off and fences every revision change', () => {
    const first = mutate('read')
    expect(first).toMatchObject({ control: { revision: 1, automationEnabled: false, schedulerPaused: false, masterStop: false } })
    expect(claim(TOKEN_1, null)).toMatchObject({ result: 'idle', reason: 'no_eligible_organization' })
    const enabled = mutate('enable', { expectedRevision: 1 })
    expect(enabled).toMatchObject({ revision: 2, automationEnabled: true })
    const stale = runSqlResult(url as string, `SELECT public.outreach_operations_mutate(${lit(ids.owner)},${lit(ids.org)},'enable',${json({ expectedRevision: 1 })});`)
    expect(stale.code).not.toBe(0)
    expect(stale.err).toMatch(/operations:stale/)
    expect(mutate('pause', { expectedRevision: 2 })).toMatchObject({ revision: 3, schedulerPaused: true })
    expect(mutate('resume', { expectedRevision: 3 })).toMatchObject({ revision: 4, schedulerPaused: false })
    expect(mutate('stop', { expectedRevision: 4 })).toMatchObject({ revision: 5, masterStop: true })
    expect(mutate('resumeStop', { expectedRevision: 5 })).toMatchObject({ revision: 6, masterStop: false })
  })

  it('refuses members and resolves a current owner/admin actor for cron', () => {
    const forbidden = runSqlResult(url as string, `SELECT public.outreach_operations_mutate(${lit(ids.member)},${lit(ids.org)},'read','{}'::jsonb);`)
    expect(forbidden.code).not.toBe(0)
    expect(forbidden.err).toMatch(/operations:forbidden/)
    expect(claim(TOKEN_1, ids.emptyOrg)).toMatchObject({ result: 'idle', reason: 'no_owner_admin' })
    expect(claim(TOKEN_1, ids.org)).toMatchObject({ result: 'claimed', actorId: ids.owner, role: 'owner', phase: 'campaign' })
  })

  it('stops cron claims when the only owner is demoted to member', () => {
    mutate('enable', { expectedRevision: 1 })
    sql(`UPDATE public.users SET role='member' WHERE id=${lit(ids.owner)};`)
    expect(claim(TOKEN_1, ids.org)).toMatchObject({ result: 'idle', reason: 'no_owner_admin' })
    expect(claim(TOKEN_2, null)).toMatchObject({ result: 'idle', reason: 'no_eligible_organization' })
  })

  it('rotates phases fairly and refuses an overlapping claim of a live phase', () => {
    mutate('enable', { expectedRevision: 1 })
    const phases = [TOKEN_1, TOKEN_2, TOKEN_3, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'].map((token) => claim(token, ids.org))
    expect(phases.map((outcome) => outcome.phase)).toEqual(['campaign', 'body', 'decision', 'reply'])
    const overlap = claim('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', ids.org)
    expect(overlap).toMatchObject({ result: 'idle', reason: 'phase_busy', phase: 'campaign' })
    expect(sql("SELECT count(*) FROM public.outreach_operations_runs WHERE status='running';")).toBe('4')
  })

  it('obeys scheduler pause and the master stop for a manual tick', () => {
    mutate('enable', { expectedRevision: 1 })
    mutate('pause', { expectedRevision: 2 })
    expect(claim(TOKEN_1, ids.org)).toMatchObject({ result: 'idle', reason: 'scheduler_paused' })
    mutate('resume', { expectedRevision: 3 })
    mutate('stop', { expectedRevision: 4 })
    expect(claim(TOKEN_2, ids.org)).toMatchObject({ result: 'idle', reason: 'master_stop' })
    expect(sql('SELECT count(*) FROM public.outreach_operations_runs;')).toBe('0')
  })

  it('skips a busy organization so the global round-robin does not starve others', () => {
    mutate('enable', { expectedRevision: 1 })
    const otherEnabled = parseJson<Record<string, unknown>>(
      sql(`SELECT public.outreach_operations_mutate(${lit(ids.otherOwner)},${lit(ids.otherOrg)},'enable',${json({ expectedRevision: 1 })});`),
    )
    expect(otherEnabled).toMatchObject({ automationEnabled: true })
    expect(claim(TOKEN_1, ids.org)).toMatchObject({ phase: 'campaign', organizationId: ids.org })
    const global = claim(TOKEN_2, null)
    expect(global).toMatchObject({ result: 'claimed', organizationId: ids.otherOrg, actorId: ids.otherOwner, phase: 'campaign' })
    expect(claim(TOKEN_3, null)).toMatchObject({ result: 'idle', reason: 'no_eligible_organization' })
  })

  it('fences a stale settlement and holds an expired external run as unknown', () => {
    mutate('enable', { expectedRevision: 1 })
    const outcome = claim(TOKEN_1, ids.org)
    const scope = outcome.scopeKey as string
    const expiry = outcome.leaseExpiresAt as string
    expect(
      sql(`SELECT public.outreach_operations_settle(${lit(ids.org)},${lit(scope)},${lit(TOKEN_2)},${lit(expiry)}::timestamptz,'completed');`),
    ).toContain('"not_found"')
    sql(`UPDATE public.outreach_operations_runs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE lease_token=${lit(TOKEN_1)};
         UPDATE public.outreach_operations_leases SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE lease_token=${lit(TOKEN_1)};`)
    expect(Number(sql('SELECT public.outreach_operations_expire_runs();'))).toBeGreaterThanOrEqual(1)
    expect(sql(`SELECT status||':'||reason FROM public.outreach_operations_runs WHERE lease_token=${lit(TOKEN_1)};`)).toBe('held:lease_expired_outcome_unknown')
    const late = sql(`SELECT public.outreach_operations_settle(${lit(ids.org)},${lit(scope)},${lit(TOKEN_1)},${lit(expiry)}::timestamptz,'completed');`)
    expect(late).toContain('"stale"')
    expect(sql('SELECT count(*) FROM public.outreach_operations_leases;')).toBe('0')
  })

  it('enforces the master outbound stop at reserve and authorize without blocking settlement', () => {
    mutate('stop', { expectedRevision: 1 })
    for (const action of ['reserve', 'authorize']) {
      expect(parseJson<Record<string, unknown>>(sql(`SELECT public.email_dispatch_mutate(${lit(ids.owner)},${lit(ids.org)},${lit(action)},'{}'::jsonb);`))).toMatchObject({ allowed: false, reason: 'outbound_stopped' })
      expect(parseJson<Record<string, unknown>>(sql(`SELECT public.outreach_reply_mutate(${lit(ids.owner)},${lit(ids.org)},${lit(action)},'{}'::jsonb);`))).toMatchObject({ allowed: false, reason: 'outbound_stopped' })
    }
    const settle = parseJson<Record<string, unknown>>(
      sql(`SELECT public.email_dispatch_mutate(${lit(ids.owner)},${lit(ids.org)},'settle',${json({ claimToken: TOKEN_3 })});`),
    )
    expect(settle.reason).not.toBe('outbound_stopped')
    expect(settle).toMatchObject({ allowed: false, reason: 'claim_not_found' })
  })

  it('scopes the stop to one organization', () => {
    mutate('stop', { expectedRevision: 1 })
    expect(sql(`SELECT public.outreach_operations_outbound_stopped(${lit(ids.org)});`)).toBe('t')
    expect(sql(`SELECT public.outreach_operations_outbound_stopped(${lit(ids.otherOrg)});`)).toBe('f')
  })

  it('reports readiness blockers instead of asserting readiness', () => {
    const readiness = parseJson<{ ready: boolean; blockers: { code: string }[] }>(
      sql(`SELECT public.outreach_operations_readiness(${lit(ids.org)});`),
    )
    expect(readiness.ready).toBe(false)
    const codes = readiness.blockers.map((blocker) => blocker.code)
    expect(codes).toContain('dispatch_configuration')
    expect(codes).not.toContain('winnr_connection')
    expect(codes).not.toContain('smtp_mailbox')
  })

  it('records a pending body from the canonical event and surfaces it as attention', () => {
    const endpoint = parseJson<{ endpointId: string }>(
      sql(`SELECT public.winnr_prepare_ingestion(${lit(ids.owner)},${lit(ids.org)},${lit(ids.connection)},1,'https://fixture.example/webhook','secret-ciphertext',${VERIFIED_EVENTS});`),
    ).endpointId
    const received = parseJson<{ duplicate: boolean }>(
      sql(`SELECT public.winnr_receive_event(${lit(endpoint)},${json({
        id: 'evt_ops_received_1',
        object: 'event',
        type: 'email.received',
        created: '2026-10-05T12:00:00.000Z',
        account_id: 'winnr-acct',
        data: { mailbox: SENDER, from: 'lead@example.com', to: SENDER, subject: 'Re: Step', message_id: '<inbound-1@example.com>', received_at: '2026-10-05T12:00:00.000Z' },
      })},${lit('b'.repeat(64))},'webhook');`),
    )
    expect(received.duplicate).toBe(false)
    expect(sql("SELECT count(*) FROM public.winnr_ingested_messages WHERE body_status='pending';")).toBe('1')
    expect(sql("SELECT count(*) FROM public.outreach_outbox WHERE consumer='winnr.ingestion.body';")).toBe('1')
    // The receipt id is recoverable from the canonical event payload the consumer reads.
    expect(
      sql("SELECT (e.data->>'receiptId') IS NOT NULL FROM public.outreach_outbox o JOIN public.outreach_events e ON e.id=o.event_id WHERE o.consumer='winnr.ingestion.body';"),
    ).toBe('t')
    const attention = parseJson<{ attention: { kind: string; referenceId: string }[] }>(sql(`SELECT public.outreach_operations_mutate(${lit(ids.owner)},${lit(ids.org)},'read','{}'::jsonb);`))
    expect(attention.attention.map((item) => item.kind)).toContain('body_pending')
  })

  it('surfaces unknown SMTP, model and provider work and never auto-resets it', () => {
    sql(`INSERT INTO public.email_dispatch_attempts(organization_id,actor_id,campaign_id,enrollment_id,lead_id,step_number,revision,sequence_snapshot,settings_snapshot,connection_id,connection_version,mailbox_id,account_id,message,fingerprint,status,lease_expires_at)
         VALUES(${lit(ids.org)},${lit(ids.owner)},${lit(ids.campaign)},${lit(ids.enrollment)},${lit(ids.lead)},1,now(),'{}'::jsonb,'{}'::jsonb,${lit(ids.connection)},1,${lit(MAILBOX)},${lit(ids.account)},${json({ to: 'lead@example.com' })},${lit('f'.repeat(64))},'unknown',now()+interval '1 day');`)
    sql(`INSERT INTO public.winnr_operations(id,organization_id,connection_id,connection_version,action,mailbox_ids,status,request_fingerprint)
         VALUES('99999999-9999-4999-8999-999999999999',${lit(ids.org)},${lit(ids.connection)},1,'enable','[]'::jsonb,'unknown','provider-fp');`)
    sql(`INSERT INTO public.outreach_operations_runs(organization_id,phase,scope_key,status,reason,lease_token,lease_expires_at,actor_id)
         VALUES(${lit(ids.org)},'body','body','held','lease_expired_outcome_unknown',${lit(TOKEN_1)},now()-interval '1 minute',${lit(ids.owner)});`)
    const read = parseJson<{ attention: { kind: string }[] }>(sql(`SELECT public.outreach_operations_mutate(${lit(ids.owner)},${lit(ids.org)},'read','{}'::jsonb);`))
    const kinds = read.attention.map((item) => item.kind)
    expect(kinds).toContain('smtp_unknown')
    expect(kinds).toContain('provider_unknown')
    expect(kinds).toContain('run_held')
    expect(Number(sql('SELECT public.outreach_operations_expire_runs();'))).toBe(0)
    expect(sql("SELECT count(*) FROM public.email_dispatch_attempts WHERE status='unknown';")).toBe('1')
  })

  it('rotates campaign selection by durable campaign-phase attempts, not settled sends', () => {
    mutate('enable', { expectedRevision: 1 })
    // The first active campaign can produce no effect (killed config); the
    // second is genuinely eligible. Selection must still alternate.
    const later = '33333333-3333-4333-8333-333333333334'
    sql(`UPDATE public.email_dispatch_config SET killed=true WHERE campaign_id=${lit(ids.campaign)};`)
    sql(`INSERT INTO public.campaigns(id,organization_id,name,status,settings,stats,updated_at)
         SELECT ${lit(later)},organization_id,'Eligible later campaign','active','{}'::jsonb,'{}'::jsonb,now()
         FROM public.campaigns WHERE id=${lit(ids.campaign)};`)
    sql(`INSERT INTO public.email_dispatch_config
         SELECT ${lit(later)},organization_id,sender_name,sender_company,business_address,sender_email,mailbox_id,mailbox_daily_limit,connection_id,connection_version,false
         FROM public.email_dispatch_config WHERE campaign_id=${lit(ids.campaign)};`)
    sql(`INSERT INTO public.campaign_sequences(campaign_id,step_number,subject,body_html,body_text,condition_type,delay_days,delay_hours)
         VALUES(${lit(later)},1,'Step','','Body','always',0,0);`)
    sql(`INSERT INTO public.campaign_leads(campaign_id,lead_id,status,current_step)
         VALUES(${lit(later)},${lit(ids.lead)},'pending',0);`)
    const chosen = new Set<string>()
    for (let index = 0; index < 8; index += 1) {
      const token = `eeeeeeee-eeee-4eee-8eee-${String(index).padStart(12, '0')}`
      const outcome = claim(token, ids.org)
      if (outcome.phase === 'campaign' && typeof outcome.campaignId === 'string') chosen.add(outcome.campaignId)
      sql(`SELECT public.outreach_operations_settle(${lit(ids.org)},${lit(String(outcome.scopeKey))},${lit(token)},${lit(String(outcome.leaseExpiresAt))}::timestamptz,'blocked','no_effect');`)
    }
    expect(Array.from(chosen).toSorted()).toEqual([ids.campaign, later].toSorted())
  })

  it('serializes a committed master stop against queued campaign and reply authorization', async () => {
    mutate('read')
    const revision = Number(parseJson<{ control: { revision: number } }>(sql(`SELECT public.outreach_operations_mutate(${lit(ids.owner)},${lit(ids.org)},'read','{}'::jsonb);`)).control.revision)
    const holder = openPsqlSession()
    const campaign = openPsqlSession()
    const reply = openPsqlSession()
    try {
      // Hold the shared email-dispatch organization lock and stage an
      // uncommitted stop in the same transaction.
      holder.send(`BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('email-dispatch:${ids.org}',0));`)
      holder.send(`SELECT public.outreach_operations_mutate(${lit(ids.owner)},${lit(ids.org)},'stop',${json({ expectedRevision: revision })});`)
      holder.send("SELECT '<<HOLDER_STOP_STAGED>>';")
      await holder.waitFor('<<HOLDER_STOP_STAGED>>')
      // Both wrappers queue on the same lock *before* the stop commits.
      campaign.send(`SELECT public.email_dispatch_mutate(${lit(ids.owner)},${lit(ids.org)},'authorize','{}'::jsonb); SELECT '<<CAMPAIGN_DONE>>';`)
      reply.send(`SELECT public.outreach_reply_mutate(${lit(ids.owner)},${lit(ids.org)},'reserve','{}'::jsonb); SELECT '<<REPLY_DONE>>';`)
      await waitForUngrantedAdvisoryLocks(2)
      holder.send("COMMIT; SELECT '<<HOLDER_COMMITTED>>';")
      await holder.waitFor('<<HOLDER_COMMITTED>>')
      const campaignOutput = await campaign.waitFor('<<CAMPAIGN_DONE>>')
      const replyOutput = await reply.waitFor('<<REPLY_DONE>>')
      expect(campaignOutput).toContain('"outbound_stopped"')
      expect(replyOutput).toContain('"outbound_stopped"')
      expect(sql(`SELECT master_stop FROM public.outreach_operations_control WHERE organization_id=${lit(ids.org)};`)).toBe('t')
    } finally {
      holder.end()
      campaign.end()
      reply.end()
    }
  })
})
