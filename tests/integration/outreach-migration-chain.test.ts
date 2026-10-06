/**
 * Additive 020→033 migration-chain proof.
 *
 * This suite installs the exact committed 14-table live-schema baseline (see
 * `tests/fixtures/baseline-outreach.sql`, extracted from the sanitized live
 * `public` schema object copied verbatim to
 * `tests/fixtures/live-schema-2026-10-05.json`), plus `auth.users` and the
 * Supabase roles / legacy RLS, and then applies every additive outreach
 * migration 020 through 033 in order.
 *
 * It then exercises the real production functions end to end over a fake
 * provider (no SMTP/IMAP/network calls):
 *
 *   lead proof (028) → campaign reserve/authorize (024) → accepted receipt
 *   (024 → sent_emails) → inbound provider receipt (027) → reply stop
 *   (027/024) → suppression (027 → 023) blocking an in-flight touch.
 *
 * Safety: the only target is an explicit
 * `OUTREACH_CHAIN_TEST_DATABASE_URL` pointing at
 * postgres://127.0.0.1:55439/coldforge_outreach_chain_test. It is validated
 * before any DDL, libpq `PG*` variables are stripped, no production Supabase
 * environment variable is ever consulted, and the test creates no other
 * database.
 */
import { createHash } from 'node:crypto'
import { prepareReply,replyContextSchema } from '@/lib/outreach/replies'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { requireSafeFixtureUrl, runSql, runSqlResult } from '../helpers/postgres-fixture'

const ENV_NAME = 'OUTREACH_CHAIN_TEST_DATABASE_URL'
const DATABASE = 'coldforge_outreach_chain_test'

// Validate the explicit target before any DDL. Unset => the suite is skipped;
// set but unsafe => this throws at import time, before a single statement runs.
const rawUrl = process.env[ENV_NAME]
const fixture = rawUrl ? requireSafeFixtureUrl(ENV_NAME, DATABASE) : null
const url = fixture?.url

const baselineSql = readFileSync('tests/fixtures/baseline-outreach.sql', 'utf8')
const legacyRlsSql = readFileSync('supabase/migrations/002_rls_policies.sql', 'utf8')
type LiveColumn = {
  table_name: string
  column_name: string
  data_type: string
  udt_name: string
  is_nullable: string
  column_default: string | null
  ordinal_position: number
}
type LiveConstraint = { table_name: string; conname: string; contype: string; definition: string }
type LiveIndex = { tablename: string; indexname: string; indexdef: string }

const liveSchema = JSON.parse(readFileSync('tests/fixtures/live-schema-2026-10-05.json', 'utf8')) as {
  columns: LiveColumn[]
  constraints: LiveConstraint[]
  indexes: LiveIndex[]
}

/** The 14 historical public tables the baseline fixture reproduces. */
const BASELINE_TABLES = [...new Set(liveSchema.columns.map((column) => column.table_name))].sort()

/**
 * Indexes the live snapshot records that are *not* emitted by a PRIMARY KEY or
 * UNIQUE constraint (those are created implicitly by the ADD CONSTRAINT list).
 * These 33 definitions must be replayed verbatim by the baseline.
 */
const constraintBackedIndexes = new Set(
  liveSchema.constraints.filter((constraint) => constraint.contype === 'p' || constraint.contype === 'u').map((constraint) => constraint.conname),
)
const metadataReplayIndexes = liveSchema.indexes.filter((index) => !constraintBackedIndexes.has(index.indexname))

/** Additive migrations in order; the baseline replaces the unusable 001–019 chain. */
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
  '032_outreach_reconciliation.sql',
  '033_outreach_downstream.sql',
]

const ids = {
  org: '11111111-1111-4111-8111-111111111111',
  other: '11111111-1111-4111-8111-111111111112',
  actor: '22222222-2222-4222-8222-222222222222',
  member: '22222222-2222-4222-8222-222222222223',
  campaign: '33333333-3333-4333-8333-333333333333',
  lead: '44444444-4444-4444-8444-444444444444',
  lead2: '44444444-4444-4444-8444-444444444445',
  enrollment: '55555555-5555-4555-8555-555555555555',
  enrollment2: '55555555-5555-4555-8555-555555555556',
  connection: '66666666-6666-4666-8666-666666666666',
  account: '77777777-7777-4777-8777-777777777777',
  evidenceOp: '88888888-8888-4888-8888-888888888888',
  evidenceOp2: '88888888-8888-4888-8888-888888888889',
}

const FINGERPRINT = 'a'.repeat(64)
const OUTBOUND_MESSAGE_ID = '<chain-1@example.com>'
const SENDER = 'sender@example.com'
const MAILBOX = 'provider-mailbox'
// SQL literal for the exact four subscriptions final027 requires; the
// `p_events` argument is the seventh positional parameter.
const VERIFIED_EVENTS = "ARRAY['email.received','message.relayed','email.bounced','email.complained']"

function sql(statement: string): string {
  return runSql(url as string, statement)
}
function json(value: unknown): string {
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`
}
function lit(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}
function parseJson<T>(output: string): T {
  return JSON.parse(output) as T
}

/** Run a query returning tab-delimited rows, one per line; [] when empty. */
const baselineCatalog = new Map<string,string[][]>()
function rows(statement: string): string[][] {
  const output = sql(statement)
  return output.length === 0 ? [] : output.split('\n').map((line) => line.split('\t'))
}

function mutate(action: string, payload: Record<string, unknown>): Record<string, unknown> {
  const output = sql(
    `SELECT public.email_dispatch_mutate(${lit(ids.actor)},${lit(ids.org)},${lit(action)},${json(payload)});`,
  )
  return parseJson<Record<string, unknown>>(output)
}

function campaignSettings(): Record<string, unknown> {
  return {
    timezone: 'UTC',
    sendingWindowStart: 0,
    sendingWindowEnd: 24,
    skipWeekends: false,
    dailyLimit: 10,
    mailboxIds: [MAILBOX],
    senderConnectionId: ids.connection,
    senderConnectionVersion: 1,
  }
}

function seed(): void {
  const settings = json(campaignSettings())
  sql(`
TRUNCATE public.lead_validation_operations, public.lead_validation_evidence,
  public.winnr_message_id_maps, public.winnr_ingested_messages, public.winnr_ingestion_receipts,
  public.winnr_ingestion_endpoints, public.winnr_mailbox_credentials, public.winnr_operations,
  public.winnr_connections, public.email_dispatch_attempts, public.email_dispatch_config,
  public.outreach_outbox, public.outreach_events, public.outreach_suppressions,
  public.thread_messages, public.threads, public.replies, public.sent_emails,
  public.campaign_leads, public.campaign_sequences, public.campaigns, public.leads,
  public.email_accounts, public.lead_lists, public.domains, public.warmup_emails,
  public.users, public.organizations, auth.users CASCADE;

INSERT INTO public.organizations(id,name,slug,plan)
  VALUES(${lit(ids.org)},'Chain Fixture','chain-fixture','starter');
INSERT INTO auth.users(id,email,raw_user_meta_data)
  VALUES(${lit(ids.actor)},'actor@example.com','{"full_name":"Chain Actor"}'::jsonb),
        (${lit(ids.member)},'member@example.com','{}'::jsonb);
INSERT INTO public.users(id,organization_id,email,role)
  VALUES(${lit(ids.actor)},${lit(ids.org)},'actor@example.com','owner'),
        (${lit(ids.member)},${lit(ids.org)},'member@example.com','member');
INSERT INTO public.email_accounts(id,organization_id,email,provider,status)
  VALUES(${lit(ids.account)},${lit(ids.org)},${lit(SENDER)},'smtp','active');
INSERT INTO public.winnr_connections(id,organization_id,provider_account_id,token_ciphertext,version,permissions)
  VALUES(${lit(ids.connection)},${lit(ids.org)},'winnr-acct','ciphertext',1,'["read","write"]');
INSERT INTO public.winnr_mailbox_credentials(organization_id,connection_id,provider_mailbox_id,connection_version,email,account_id,credentials_ciphertext)
  VALUES(${lit(ids.org)},${lit(ids.connection)},${lit(MAILBOX)},1,${lit(SENDER)},${lit(ids.account)},'mailbox-ciphertext');
INSERT INTO public.campaigns(id,organization_id,name,status,settings,stats,updated_at)
  VALUES(${lit(ids.campaign)},${lit(ids.org)},'Chain Campaign','draft',${settings},'{}'::jsonb,now());
INSERT INTO public.leads(id,organization_id,email,status)
  VALUES(${lit(ids.lead)},${lit(ids.org)},'lead@example.com','active'),
        (${lit(ids.lead2)},${lit(ids.org)},'lead2@example.com','active');
INSERT INTO public.campaign_leads(id,campaign_id,lead_id,status,current_step)
  VALUES(${lit(ids.enrollment)},${lit(ids.campaign)},${lit(ids.lead)},'pending',0),
        (${lit(ids.enrollment2)},${lit(ids.campaign)},${lit(ids.lead2)},'pending',0);
INSERT INTO public.campaign_sequences(campaign_id,step_number,subject,body_html,body_text,condition_type,delay_days,delay_hours)
  VALUES(${lit(ids.campaign)},1,'Chain step','','Chain immutable body','always',0,0),
        (${lit(ids.campaign)},2,'Follow up','','Follow up','not_replied',1,0);
`)
}

/** Create the real 028 evidence claim for a lead through the production RPCs. */
function finalizeValidProof(operationId: string, leadId: string, email: string): void {
  const reserved = parseJson<{ state: string }>(
    sql(`SELECT public.lead_validation_reserve_operation(${lit(operationId)},${lit(ids.actor)},${lit(ids.org)},${lit(leadId)},'zerobounce');`),
  )
  expect(reserved.state).toBe('reserved')
  const finalized = parseJson<{ state: string; validationStatus: string }>(
    sql(
      `SELECT public.lead_validation_finalize_provider(${lit(operationId)},${lit(ids.actor)},${lit(ids.org)},${lit(leadId)},` +
        `'zerobounce',${lit(email)},'valid','deliverable','chain-ref',now());`,
    ),
  )
  expect(finalized.state).toBe('completed')
  expect(finalized.validationStatus).toBe('valid')
}

/** Configure + start the campaign. Returns the reserve snapshot for step 1. */
function startCampaign(): { step: unknown; configuration: unknown } {
  sql(`SELECT public.winnr_prepare_ingestion(${lit(ids.actor)},${lit(ids.org)},${lit(ids.connection)},1,'wh_chain','secret-ciphertext',${VERIFIED_EVENTS});`)
  expect(mutate('configure', {
    campaignId: ids.campaign,
    senderName: 'Chain Sender',
    senderCompany: 'Chain Co',
    businessAddress: '1 Chain Street',
    senderEmail: SENDER,
    mailboxId: MAILBOX,
    mailboxDailyLimit: 10,
  }).configured).toBe(true)
  expect(mutate('start', { campaignId: ids.campaign }).ready).toBe(true)
  return parseJson<{ step: unknown; configuration: unknown }>(
    sql(`SELECT jsonb_build_object('step',to_jsonb(s),'configuration',to_jsonb(cfg))
         FROM public.campaign_sequences s, public.email_dispatch_config cfg
         WHERE s.campaign_id=${lit(ids.campaign)} AND cfg.campaign_id=s.campaign_id AND s.step_number=1;`),
  )
}

function reserve(enrollmentId: string, snapshot: { step: unknown; configuration: unknown }): Record<string, unknown> {
  return mutate('reserve', {
    campaignId: ids.campaign,
    enrollmentId,
    message: {
      from: SENDER,
      to: enrollmentId === ids.enrollment ? 'lead@example.com' : 'lead2@example.com',
      subject: 'Chain step',
      text: 'Chain immutable body',
      messageId: OUTBOUND_MESSAGE_ID,
    },
    fingerprint: FINGERPRINT,
    step: snapshot.step,
    configuration: snapshot.configuration,
  })
}

function authorize(claimToken: unknown): Record<string, unknown> {
  return mutate('authorize', {
    claimToken,
    connectionId: ids.connection,
    connectionVersion: 1,
    mailboxId: MAILBOX,
    fingerprint: FINGERPRINT,
  })
}

function replyMutate(action:string,payload:Record<string,unknown>):Record<string,unknown>{return parseJson(sql(`SELECT public.outreach_reply_mutate(${lit(ids.actor)},${lit(ids.org)},${lit(action)},${json(payload)})`))}
function agentMutate(action:string,payload:Record<string,unknown>):Record<string,unknown>{return parseJson(sql(`SELECT public.outreach_agent_mutate(${lit(ids.actor)},${lit(ids.org)},${lit(action)},${json(payload)})`))}
function receive(payload:Record<string,unknown>):Record<string,unknown>{return parseJson(sql(`SELECT public.winnr_receive_event((SELECT id FROM public.winnr_ingestion_endpoints WHERE organization_id=${lit(ids.org)}),${json(payload)},${lit('b'.repeat(64))})`))}
function inboundConversation():string{
 finalizeValidProof(ids.evidenceOp,ids.lead,'lead@example.com');const snapshot=startCampaign();const a=reserve(ids.enrollment,snapshot).attempt as {claim_token:string};expect(authorize(a.claim_token).allowed).toBe(true);expect(mutate('settle',{claimToken:a.claim_token,outcome:'accepted',messageId:OUTBOUND_MESSAGE_ID,recipient:'lead@example.com'}).status).toBe('accepted')
 receive({id:'evt_question',object:'event',type:'email.received',created:new Date().toISOString(),account_id:'winnr-acct',data:{mailbox:SENDER,from:'lead@example.com',to:SENDER,subject:'Question',message_id:'<chain-question@example.com>',in_reply_to:OUTBOUND_MESSAGE_ID}})
 sql(`SELECT public.winnr_save_ingested_body(${lit(ids.actor)},${lit(ids.org)},id,'123','What is the price?',false,${lit(ids.connection)},1) FROM public.winnr_ingested_messages`)
 return sql('SELECT thread_id FROM public.replies')
}

const complaintFingerprint = 'c'.repeat(64)

describe.skipIf(!url)('additive 020→033 chain over the live 14-table baseline', () => {
  beforeAll(() => {
    // Roles/RLS + auth.users mirror the sanitized live contract. The baseline
    // file creates the 14 public tables exactly as the live schema does.
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
`)
    expect(runSqlResult(url as string, baselineSql).code).toBe(0)
    expect(runSqlResult(url as string, legacyRlsSql).code).toBe(0)
    const baselineList = BASELINE_TABLES.map(table=>lit(table)).join(',')
    baselineCatalog.set('0',rows(`
SELECT table_name||'\t'||column_name||'\t'||data_type||'\t'||is_nullable||'\t'||coalesce(column_default,'(none)')
FROM information_schema.columns
WHERE table_schema='public' AND table_name IN (${baselineList})
ORDER BY table_name, ordinal_position;`))
    baselineCatalog.set('1',rows(`
SELECT c.conname||'\t'||c.contype::text||'\t'||pg_get_constraintdef(c.oid)
FROM pg_constraint c
JOIN pg_class t ON t.oid=c.conrelid
JOIN pg_namespace n ON n.oid=t.relnamespace
WHERE n.nspname='public' AND t.relname IN (${baselineList}) AND c.contype IN ('p','u','c','f')
ORDER BY c.conname;`))
    baselineCatalog.set('2',rows(`
SELECT i.indexname||'\t'||i.indexdef
FROM pg_indexes i
WHERE i.schemaname='public' AND i.tablename IN (${baselineList})
ORDER BY i.indexname;`))

    expect(readdirSync('supabase/migrations').filter(file=>/^\d+_.*\.sql$/.test(file)&&Number(file.split('_')[0])>=20).sort()).toEqual(ADDITIVE_MIGRATIONS)
    for (const file of ADDITIVE_MIGRATIONS) {
      const result = runSqlResult(url as string, readFileSync(`supabase/migrations/${file}`, 'utf8'))
      expect(result.code, `${file}: ${result.err}`).toBe(0)
    }
  })

  beforeEach(() => seed())

  it('committed fixture covers exactly the live 14-table public contract', () => {
    expect(BASELINE_TABLES).toHaveLength(14)
    expect(BASELINE_TABLES).toContain('campaign_leads')
    // The baseline is historical public schema only; additive 020+ tables must
    // not leak into the live baseline fixture.
    expect(BASELINE_TABLES).not.toContain('outreach_events')
    expect(BASELINE_TABLES).not.toContain('email_dispatch_attempts')
    const created = [...baselineSql.matchAll(/CREATE TABLE public\.([a-z_]+)/g)].map((match) => match[1])
    expect([...new Set(created)].sort()).toEqual(BASELINE_TABLES)
    expect(liveSchema.constraints.length).toBeGreaterThan(0)
    expect(liveSchema.indexes.length).toBeGreaterThan(0)
    // All 33 non-constraint live indexes are replayed verbatim, including the
    // partial unique idx_threads_mailbox_external_unique.
    expect(metadataReplayIndexes).toHaveLength(33)
    expect(metadataReplayIndexes.map((index) => index.indexname)).toContain('idx_threads_mailbox_external_unique')
    const replayed = [...baselineSql.matchAll(/CREATE (?:UNIQUE )?INDEX [^;]+;/g)].map((match) => match[0].slice(0, -1))
    expect(replayed.slice().sort()).toEqual(metadataReplayIndexes.map((index) => index.indexdef).slice().sort())
  })

  it('replayed baseline matches the live column/default/check/FK/index contract', () => {
    // information_schema.columns is the authority the snapshot was captured from.
    const actualColumns = baselineCatalog.get('0')
    const expectedColumns = liveSchema.columns
      .filter((column) => BASELINE_TABLES.includes(column.table_name))
      .sort((a, b) => a.table_name.localeCompare(b.table_name) || a.ordinal_position - b.ordinal_position)
      .map((column) => [column.table_name, column.column_name, column.data_type, column.is_nullable, column.column_default ?? '(none)'])
    expect(actualColumns).toEqual(expectedColumns)

    const actualConstraints = baselineCatalog.get('1')
    const expectedConstraints = liveSchema.constraints
      .filter((constraint) => BASELINE_TABLES.includes(constraint.table_name))
      .sort((a, b) => a.conname.localeCompare(b.conname))
      .map((constraint) => [constraint.conname, constraint.contype, constraint.definition])
    expect(actualConstraints).toEqual(expectedConstraints)

    const actualIndexes = baselineCatalog.get('2')
    const expectedIndexes = liveSchema.indexes
      .filter((index) => BASELINE_TABLES.includes(index.tablename))
      .sort((a, b) => a.indexname.localeCompare(b.indexname))
      .map((index) => [index.indexname, index.indexdef])
    expect(actualIndexes).toEqual(expectedIndexes)
  })

  it('rejects a duplicate nonnull (mailbox_id,thread_external_id) and allows nulls', () => {
    sql(`INSERT INTO public.threads(organization_id,mailbox_id,subject,participant_email,thread_external_id)
         VALUES(${lit(ids.org)},${lit(ids.account)},'t1','p1@example.com','ext-1');`)
    // The live partial unique index rejects a second row with the same mailbox
    // and a nonnull external id; the historical fixture must not mask it.
    const duplicate = runSqlResult(
      url as string,
      `INSERT INTO public.threads(organization_id,mailbox_id,subject,participant_email,thread_external_id)
       VALUES(${lit(ids.org)},${lit(ids.account)},'t2','p2@example.com','ext-1');`,
    )
    expect(duplicate.code).not.toBe(0)
    expect(duplicate.err).toMatch(/idx_threads_mailbox_external_unique|duplicate key value/)
    // A distinct external id in the same mailbox is allowed.
    expect(
      runSqlResult(
        url as string,
        `INSERT INTO public.threads(organization_id,mailbox_id,subject,participant_email,thread_external_id)
         VALUES(${lit(ids.org)},${lit(ids.account)},'t3','p3@example.com','ext-2');`,
      ).code,
    ).toBe(0)
    // NULL external ids fall outside the partial index and may repeat.
    expect(
      runSqlResult(
        url as string,
        `INSERT INTO public.threads(organization_id,mailbox_id,subject,participant_email,thread_external_id)
         VALUES(${lit(ids.org)},${lit(ids.account)},'n1','n1@example.com',NULL),
                (${lit(ids.org)},${lit(ids.account)},'n2','n2@example.com',NULL);`,
      ).code,
    ).toBe(0)
    expect(sql(`SELECT count(*) FROM public.threads WHERE thread_external_id IS NULL;`)).toBe('2')
  })

  it('installs every additive migration and the real 028 helper', () => {
    const expected = [
      'public.email_dispatch_mutate(uuid,uuid,text,jsonb)',
      'public.record_outreach_suppression(uuid,text,text,text,text,text,timestamp with time zone,uuid)',
      'public.winnr_receive_event(uuid,jsonb,text,text)',
      'public.lead_validation_finalize_provider(uuid,uuid,uuid,uuid,text,text,text,text,text,timestamp with time zone)',
      'public.lead_validation_is_current(uuid,uuid,text,timestamp with time zone)',
      'public.outreach_reply_mutate(uuid,uuid,text,jsonb)',
      'public.outreach_agent_mutate(uuid,uuid,text,jsonb)',
      'public.outreach_operations_mutate(uuid,uuid,text,jsonb)',
      'public.outreach_reconciliation_mutate(uuid,uuid,text,jsonb)',
    ]
    for (const signature of expected) {
      expect(sql(`SELECT to_regprocedure(${lit(signature)}) IS NOT NULL;`), signature).toBe('t')
    }
    expect(sql(`SELECT to_regclass('public.winnr_ingestion_receipts') IS NOT NULL;`)).toBe('t')
    expect(sql(`SELECT to_regclass('public.lead_validation_evidence') IS NOT NULL;`)).toBe('t')
  })

  it('real 028 lead proof gates real 024 reserve without any surrogate helper', () => {
    expect(sql(`SELECT public.lead_validation_is_current(${lit(ids.org)},${lit(ids.lead)},'lead@example.com',now());`)).toBe('f')
    expect(sql(`SELECT public.email_dispatch_validation_current(${lit(ids.org)},${lit(ids.lead)},'lead@example.com',now());`)).toBe('f')
    finalizeValidProof(ids.evidenceOp, ids.lead, 'lead@example.com')
    expect(sql(`SELECT public.lead_validation_is_current(${lit(ids.org)},${lit(ids.lead)},'lead@example.com',now());`)).toBe('t')
    expect(sql(`SELECT public.email_dispatch_validation_current(${lit(ids.org)},${lit(ids.lead)},'lead@example.com',now());`)).toBe('t')
    // A mismatch between the receipt address and the lead leaves no valid proof.
    sql(`UPDATE public.leads SET validation_status='valid' WHERE id=${lit(ids.lead2)};
         INSERT INTO public.lead_validation_evidence(organization_id,lead_id,email,validation_status,verification_level,source,checked_at)
         VALUES(${lit(ids.org)},${lit(ids.lead2)},'other@example.com','valid','verified_provider','zerobounce',now())
         ON CONFLICT (organization_id,lead_id) DO UPDATE SET email=EXCLUDED.email;`)
    expect(sql(`SELECT public.lead_validation_is_current(${lit(ids.org)},${lit(ids.lead2)},'lead2@example.com',now());`)).toBe('f')
  })

  it('reserves, authorizes and persists an accepted receipt into sent_emails', () => {
    finalizeValidProof(ids.evidenceOp, ids.lead, 'lead@example.com')
    const snapshot = startCampaign()
    const reservation = reserve(ids.enrollment, snapshot)
    expect(reservation.allowed).toBe(true)
    const attempt = reservation.attempt as { claim_token: string; id: string }
    expect(authorize(attempt.claim_token).allowed).toBe(true)
    const settled = mutate('settle', {
      claimToken: attempt.claim_token,
      outcome: 'accepted',
      messageId: OUTBOUND_MESSAGE_ID,
      recipient: 'lead@example.com',
    })
    expect(settled.status).toBe('accepted')
    expect(sql(`SELECT status||':'||message_id FROM public.sent_emails;`)).toBe(`sent:${OUTBOUND_MESSAGE_ID}`)
    expect(sql(`SELECT current_step FROM public.campaign_leads WHERE id=${lit(ids.enrollment)};`)).toBe('1')
    expect(sql(`SELECT count(*) FROM public.email_dispatch_attempts WHERE status='accepted';`)).toBe('1')
  })

  it('ingests an inbound provider receipt and stops the replied enrollment', () => {
    finalizeValidProof(ids.evidenceOp, ids.lead, 'lead@example.com')
    const snapshot = startCampaign()
    const attempt = reserve(ids.enrollment, snapshot).attempt as { claim_token: string }
    expect(authorize(attempt.claim_token).allowed).toBe(true)
    expect(
      mutate('settle', {
        claimToken: attempt.claim_token,
        outcome: 'accepted',
        messageId: OUTBOUND_MESSAGE_ID,
        recipient: 'lead@example.com',
      }).status,
    ).toBe('accepted')

    const endpoint = parseJson<{ endpointId: string }>(
      sql(`SELECT public.winnr_prepare_ingestion(${lit(ids.actor)},${lit(ids.org)},${lit(ids.connection)},1,'https://fixture.example/webhook','secret-ciphertext',${VERIFIED_EVENTS});`),
    ).endpointId
    const received = parseJson<{ duplicate: boolean }>(
      sql(
        `SELECT public.winnr_receive_event(${lit(endpoint)},${json({
          id: 'evt_chain_received_1',
          object: 'event',
          type: 'email.received',
          created: '2026-10-05T12:00:00.000Z',
          account_id: 'winnr-acct',
          data: {
            mailbox: SENDER,
            from: 'lead@example.com',
            to: SENDER,
            subject: 'Re: Chain step',
            message_id: '<inbound-1@example.com>',
            in_reply_to: OUTBOUND_MESSAGE_ID,
            received_at: '2026-10-05T12:00:00.000Z',
            text: 'Please stop',
          },
        })},${lit('b'.repeat(64))},'webhook');`,
      ),
    )
    expect(received.duplicate).toBe(false)
    expect(sql(`SELECT count(*) FROM public.replies WHERE organization_id=${lit(ids.org)};`)).toBe('1')
    expect(sql(`SELECT count(*) FROM public.winnr_ingested_messages WHERE organization_id=${lit(ids.org)};`)).toBe('1')
    expect(sql(`SELECT status||':'||(next_send_at IS NULL) FROM public.campaign_leads WHERE id=${lit(ids.enrollment)};`)).toBe('replied:true')
    expect(sql(`SELECT status FROM public.sent_emails;`)).toBe('replied')
  })

  it('a provider complaint suppresses the lead and blocks an in-flight authorization', () => {
    finalizeValidProof(ids.evidenceOp2, ids.lead2, 'lead2@example.com')
    const snapshot = startCampaign()
    // startCampaign validates lead2's proof is already current
    const reservation = reserve(ids.enrollment2, snapshot)
    expect(reservation.allowed).toBe(true)
    const attempt = reservation.attempt as { claim_token: string }

    const endpoint = parseJson<{ endpointId: string }>(
      sql(`SELECT public.winnr_prepare_ingestion(${lit(ids.actor)},${lit(ids.org)},${lit(ids.connection)},1,'https://fixture.example/webhook','secret-ciphertext',${VERIFIED_EVENTS});`),
    ).endpointId
    parseJson<{ duplicate: boolean }>(
      sql(
        `SELECT public.winnr_receive_event(${lit(endpoint)},${json({
          id: 'evt_chain_complaint_1',
          object: 'event',
          type: 'email.complained',
          created: '2026-10-05T12:05:00.000Z',
          account_id: 'winnr-acct',
          data: { sender: SENDER, recipient: 'lead2@example.com' },
        })},${lit(complaintFingerprint)},'webhook');`,
      ),
    )
    expect(sql(`SELECT normalized_email||':'||reason FROM public.outreach_suppressions;`)).toBe('lead2@example.com:complaint')
    expect(sql(`SELECT status FROM public.leads WHERE id=${lit(ids.lead2)};`)).toBe('complained')
    const blocked = authorize(attempt.claim_token)
    expect(blocked.allowed).toBe(false)
    expect(blocked.reason).toBe('ineligible')
  })
  it('reconciles a human reply from verified relay while outbound is stopped without replaying its logical response',()=>{
   const threadId=inboundConversation();replyMutate('readiness',{threadId});expect(replyMutate('control',{threadId,mode:'human',expectedRevision:1}).allowed).toBe(true)
   process.env.ENCRYPTION_SECRET='synthetic-chain-only'
   const context=replyContextSchema.parse(replyMutate('readiness',{threadId}));const prepared=prepareReply(context,'Human follow up','https://fixture.example')
   const reserved=replyMutate('reserve',{...context,source:'human',message:prepared.message,fingerprint:prepared.fingerprint});expect(reserved.allowed).toBe(true);const a=reserved.attempt as {id:string;claim_token:string}
   expect(mutate('authorize',{claimToken:a.claim_token,connectionId:ids.connection,connectionVersion:1,mailboxId:MAILBOX,fingerprint:prepared.fingerprint}).allowed).toBe(true)
   expect(parseJson<{saved:boolean}>(sql(`SELECT public.outreach_operations_mutate(${lit(ids.actor)},${lit(ids.org)},'stop','{"expectedRevision":1}')`)).saved).toBe(true)
   expect(mutate('settle',{claimToken:a.claim_token,outcome:'unknown',code:'smtp_network_uncertain'}).status).toBe('unknown')
   receive({id:'evt_reply_relay',object:'event',type:'message.relayed',created:new Date().toISOString(),account_id:'winnr-acct',data:{original_message_id:prepared.message.messageId,provider_message_id:'<chain-provider-reply@example.com>',recipient:'lead@example.com',sender:SENDER,relayed_at:new Date().toISOString()}})
   const reconcile=()=>parseJson<Record<string,unknown>>(sql(`SELECT public.outreach_reconciliation_mutate(${lit(ids.actor)},${lit(ids.org)},'reconcile',${json({attemptId:a.id,fingerprint:prepared.fingerprint})})`))
   expect(reconcile().status).toBe('accepted');expect(reconcile().alreadyAccepted).toBe(true)
   expect(sql(`SELECT thread_id FROM public.thread_messages WHERE id=${lit(a.id)}`)).toBe(threadId)
   expect(sql(`SELECT count(*) FROM public.sent_emails WHERE id=${lit(a.id)}`)).toBe('1');expect(sql('SELECT count(*) FROM public.outreach_reconciliation_audit')).toBe('1')
   expect(sql(`SELECT status FROM public.campaign_leads WHERE id=${lit(ids.enrollment)}`)).toBe('replied')
   expect(replyMutate('reserve',{...context,source:'human',message:prepared.message,fingerprint:prepared.fingerprint}).reason).toBe('outbound_stopped')
   sql(`SELECT public.outreach_operations_mutate(${lit(ids.actor)},${lit(ids.org)},'resumeStop','{"expectedRevision":2}')`)
   expect(replyMutate('reserve',{...context,source:'human',message:prepared.message,fingerprint:prepared.fingerprint}).reason).toBe('response_already_reserved')
  })
  it('binds real agent approval to immutable reply then human takeover blocks the shared send gate',()=>{
   const threadId=inboundConversation();const answer='A quote depends on requirements.'
   agentMutate('brief',{campaignId:ids.campaign,expectedRevision:0,brief:{audience:'Owners',problem:'Follow up',offer:'Setup',tone:'plain',cta:'A demo?',exclusions:[],claims:[],faqs:[{id:'price',intent:'question',question:'Price?',answer}]}})
   agentMutate('policy',{campaignId:ids.campaign,expectedRevision:0,policy:{enabled:true,allowedIntents:['question'],minConfidence:.95,maxReplies:1,dailyCalls:5,startHour:0,endHour:24}})
   agentMutate('model',{expectedRevision:0,model:'fixture-model',ciphertext:'synthetic-private'})
   agentMutate('enableThread',{campaignId:ids.campaign,threadId});const conversation=agentMutate('conversation',{threadId})
   const context=replyContextSchema.parse(replyMutate('readiness',{threadId}));process.env.ENCRYPTION_SECRET='synthetic-chain-only';const prepared=prepareReply(context,answer,'https://fixture.example')
   const classification={intent:'question',confidence:.99,reason:'Price question',templateId:'price',source:'model'}
   const run=agentMutate('reserve',{campaignId:ids.campaign,kind:'classify',context:'chain-classify',threadId,sourceReplyId:context.sourceReplyId,sourceBodyHash:conversation.bodyHash});expect(run.allowed).toBe(true)
   agentMutate('finish',{runId:run.runId,status:'succeeded',result:classification})
   const decision=agentMutate('decision',{campaignId:ids.campaign,threadId,sourceReplyId:context.sourceReplyId,sourceBodyHash:conversation.bodyHash,runId:run.runId,controlRevision:context.controlRevision,expectedBriefRevision:1,expectedPolicyRevision:1,classification,prepared,fingerprint:prepared.fingerprint});expect(decision.approved).toBe(true)
   // The actual 030 approved decision is the source of the 033 operation;
   // unknown provider effects must remain durable even after outbound resumes.
   const downstream=(action:string,payload:Record<string,unknown>)=>parseJson<Record<string,unknown>>(sql(`SELECT public.outreach_downstream_mutate(${lit(ids.actor)},${lit(ids.org)},${lit(action)},${json(payload)})`))
   const downstreamEffect=(action:string,payload:Record<string,unknown>)=>parseJson<Record<string,unknown>>(sql(`SELECT public.outreach_downstream_effect(${lit(ids.org)},${lit(action)},${json(payload)})`))
   const effectPayload={provider:'closebot',decisionId:decision.decisionId,effectKind:'closebot_forward',payloadFingerprint:'b'.repeat(64),connectionRevision:2}
   downstream('saveConnection',{provider:'closebot',expectedRevision:0,ciphertext:'synthetic-private-bridge',config:{sourceId:'fixture-source'}})
   expect(downstreamEffect('reserveEffect',effectPayload).reason).toBe('provider_disabled')
   downstream('setEnabled',{provider:'closebot',expectedRevision:1,enabled:true})
   const effect=downstreamEffect('reserveEffect',effectPayload);expect(effect.allowed).toBe(true)
   sql(`SELECT public.outreach_operations_mutate(${lit(ids.actor)},${lit(ids.org)},'stop','{"expectedRevision":1}')`)
   expect(downstreamEffect('claimEffect',{}).reason).toBe('master_stop')
   expect(sql(`SELECT status FROM public.outreach_downstream_effects WHERE id=${lit(String(effect.effectId))}`)).toBe('reserved')
   sql(`SELECT public.outreach_operations_mutate(${lit(ids.actor)},${lit(ids.org)},'resumeStop','{"expectedRevision":2}')`)
   const claimed=downstreamEffect('claimEffect',{});expect(claimed.effectId).toBe(effect.effectId)
   const effectContext=downstreamEffect('effectContext',{effectId:claimed.effectId,dispatchToken:claimed.dispatchToken})
   expect(effectContext.bodyReady).toBe(true);expect(effectContext.decision).toMatchObject({decisionId:decision.decisionId,sourceReplyId:context.sourceReplyId,approved:true})
   const effectPayloadText=JSON.stringify({sourceId:'fixture-source',event:{contactId:ids.lead,body:String(effectContext.replyBody),state:{coldforgeLeadId:ids.lead,decisionId:decision.decisionId,threadId,replyId:context.sourceReplyId}}})
   const effectFingerprint=createHash('sha256').update(effectPayloadText).digest('hex')
   const write=downstreamEffect('beginWrite',{kind:'effect',subjectId:claimed.effectId,actorId:ids.actor,dispatchToken:claimed.dispatchToken,connectionRevision:2,payloadText:effectPayloadText,fingerprint:effectFingerprint});expect(write.allowed,JSON.stringify(write)).toBe(true)
   expect(downstreamEffect('authorizeWrite',write).allowed).toBe(true);expect(downstreamEffect('authorizeWrite',write).allowed).toBe(false)
   expect(downstreamEffect('settleEffect',{...write,effectId:claimed.effectId,dispatchToken:claimed.dispatchToken,status:'unknown',errorCode:'synthetic_response_lost'}).result).toBe('settled')
   expect(downstreamEffect('reserveEffect',{...effectPayload,logicalKey:'browser-new-id'})).toMatchObject({allowed:false,reason:'effect_exists',status:'unknown'})
   expect(downstreamEffect('claimEffect',{}).effectId).toBeNull()
   expect(sql(`SELECT count(*) FROM public.outreach_downstream_effects WHERE decision_id=${lit(String(decision.decisionId))}`)).toBe('1')
   const approved=()=>sql(`SELECT public.outreach_reply_decision_is_authorized(${lit(ids.org)},${lit(threadId)},${lit(context.sourceReplyId)},${context.controlRevision},${lit(String(decision.decisionId))},${lit(prepared.fingerprint)},now())`)
   expect(approved()).toBe('t');expect(replyMutate('control',{threadId,mode:'human',expectedRevision:context.controlRevision}).allowed).toBe(true);expect(approved()).toBe('f')
   expect(replyMutate('reserve',{...context,source:'agent',decisionId:decision.decisionId,message:prepared.message,fingerprint:prepared.fingerprint}).allowed).toBe(false)
   expect(sql("SELECT count(*) FROM public.email_dispatch_attempts WHERE kind='reply'")).toBe('0')
   expect(sql("SELECT count(*) FROM public.outreach_events WHERE type='conversation.decision.recorded'")).toBe('1');expect(sql("SELECT count(*) FROM public.outreach_outbox WHERE consumer='outreach.conversation.decision'")).toBe('1')
  })

  it('030 runs without pgcrypto and preserves ASCII/nonASCII UTF8 SHA256 identity',()=>{
   expect(sql("SELECT count(*) FROM pg_extension WHERE extname='pgcrypto'")).toBe('0')
   const threadId=inboundConversation()
   for(const body of ['What is the price?','Café — 你好 👋']){
    sql(`UPDATE public.replies SET body_text=${lit(body)} WHERE thread_id=${lit(threadId)}`)
    const conversation=agentMutate('conversation',{threadId})
    expect(conversation.bodyHash).toBe(createHash('sha256').update(body,'utf8').digest('hex'))
   }
  })

})
