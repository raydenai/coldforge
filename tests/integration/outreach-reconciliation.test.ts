/**
 * Real PostgreSQL proof for 032 verified SMTP reconciliation.
 *
 * The suite installs the exact committed live-schema baseline plus the actual
 * additive outreach migrations 020-032, and then exercises the real
 * reconciliation RPC through the installed scheduler and reply wrappers.
 *
 * Safety: the only target is an explicit OUTREACH_RECONCILIATION_TEST_DATABASE_URL
 * pointing at postgres://127.0.0.1:55439/outreach_reconciliation_test. It is
 * validated before any DDL, libpq PG* variables are stripped, no production
 * Supabase variable is read, and no provider or network call is made.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { psqlExecutable, requireSafeFixtureUrl, runSql, runSqlResult, strippedEnv } from '../helpers/postgres-fixture'

const ENV_NAME = 'OUTREACH_RECONCILIATION_TEST_DATABASE_URL'
const DATABASE = 'outreach_reconciliation_test'
const rawUrl = process.env[ENV_NAME]
const fixture = rawUrl ? requireSafeFixtureUrl(ENV_NAME, DATABASE) : null
const url = fixture?.url

const ids = {
  org: '11111111-1111-4111-8111-111111111111',
  otherOrg: '11111111-1111-4111-8111-111111111112',
  owner: '22222222-2222-4222-8222-222222222221',
  admin: '22222222-2222-4222-8222-222222222222',
  member: '22222222-2222-4222-8222-222222222223',
  otherOwner: '22222222-2222-4222-8222-222222222224',
  removedActor: '22222222-2222-4222-8222-222222222299',
  connection: '33333333-3333-4333-8333-333333333333',
  otherConnection: '33333333-3333-4333-8333-333333333334',
  endpoint: '44444444-4444-4444-8444-444444444444',
  otherEndpoint: '44444444-4444-4444-8444-444444444445',
  endpointV2: '44444444-4444-4444-8444-444444444447',
  account: '55555555-5555-4555-8555-555555555555',
  otherAccount: '55555555-5555-4555-8555-555555555556',
  campaign: '66666666-6666-4666-8666-666666666666',
  lead: '77777777-7777-4777-8777-777777777777',
  enrollment: '88888888-8888-4888-8888-888888888888',
  thread: '99999999-9999-4999-8999-999999999991',
  aliasThread: '99999999-9999-4999-8999-999999999992',
  sourceReply: '99999999-9999-4999-8999-999999999993',
  campaignAttempt: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  replyAttempt: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
  receipt: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
}

const frozenCampaign = {
  from: 'sender@example.test',
  to: 'lead@example.test',
  subject: 'Frozen campaign',
  text: 'Frozen campaign body',
  messageId: '<frozen-campaign@example.test>',
}
const frozenReply = {
  from: 'sender@example.test',
  to: 'lead@example.test',
  subject: 'Re: Incoming',
  text: 'Frozen reply body',
  messageId: '<frozen-reply@example.test>',
  inReplyTo: '<incoming@example.test>',
}
const fingerprintA = 'a'.repeat(64)
const fingerprintB = 'b'.repeat(64)

function result(statement: string) {
  return runSqlResult(url as string, statement)
}
function ok(statement: string): string {
  const r = result(statement)
  if (r.code !== 0) throw new Error(r.err || r.out)
  return r.out
}
function sqlAsync(statement: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = execFile(psqlExecutable(), ['-X', '-v', 'ON_ERROR_STOP=1', '--dbname', url as string, '-At'], { env: strippedEnv() }, (error, out, err) =>
      resolve({ code: error ? 1 : 0, out: String(out).trim(), err: String(err).trim() }),
    )
    child.stdin?.end(statement)
  })
}
const quote = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`
function call(action: string, payload: Record<string, unknown>, actor = ids.owner, org = ids.org) {
  return result(`SELECT public.outreach_reconciliation_mutate('${actor}','${org}','${action}',${quote(payload)})`)
}
function parsed(action: string, payload: Record<string, unknown>, actor = ids.owner, org = ids.org) {
  const r = call(action, payload, actor, org)
  expect(r.code, r.err).toBe(0)
  return JSON.parse(r.out) as Record<string, unknown>
}

function insertAttempt(input: {
  id: string
  kind: 'campaign' | 'reply'
  status: string
  message?: Record<string, unknown>
  actorId?: string
  accountId?: string
  fingerprint?: string
  leaseAt?: string
  authorizedAt?: string | null
  createdAt?: string
  threadId?: string | null
  sourceReplyId?: string | null
  campaignId?: string
  connectionId?: string
  connectionVersion?: number
}) {
  const message = input.message ?? (input.kind === 'campaign' ? frozenCampaign : frozenReply)
  const enrollment = input.kind === 'campaign' ? `'${ids.enrollment}'` : 'NULL'
  const step = input.kind === 'campaign' ? '1' : 'NULL'
  const thread = input.threadId ? `'${input.threadId}'` : 'NULL'
  const source = input.sourceReplyId ? `'${input.sourceReplyId}'` : 'NULL'
  const controlRevision = input.kind === 'reply' ? '1' : 'NULL'
  const replySource = input.kind === 'reply' ? "'human'" : 'NULL'
  ok(`INSERT INTO public.email_dispatch_attempts(id,organization_id,actor_id,campaign_id,enrollment_id,lead_id,step_number,revision,sequence_snapshot,settings_snapshot,connection_id,connection_version,mailbox_id,account_id,message,fingerprint,status,lease_expires_at,authorized_at,created_at,kind,thread_id,source_reply_id,control_revision,reply_source)
   VALUES('${input.id}','${ids.org}','${input.actorId ?? ids.owner}','${input.campaignId ?? ids.campaign}',${enrollment},'${ids.lead}',${step},now(),'{}','{}','${input.connectionId ?? ids.connection}',${input.connectionVersion ?? 1},'provider-mailbox','${input.accountId ?? ids.account}',${quote(message)},'${input.fingerprint ?? fingerprintA}','${input.status}',${input.leaseAt ?? "now()+interval '2 minutes'"},${input.authorizedAt === undefined ? "now()-interval '5 minutes'" : input.authorizedAt === null ? 'NULL' : `'${input.authorizedAt}'`},${input.createdAt ?? "now()-interval '10 minutes'"},'${input.kind}',${thread},${source},${controlRevision},${replySource})`)
}

function insertRelay(input: {
  originalMessageId: string
  providerMessageId: string
  recipient?: string
  accountId?: string
  providerAccountId?: string
  endpointId?: string
  connectionId?: string
  eventId?: string
  receiptId?: string
  receiptFingerprint?: string
  receiptCreatedAt?: string
  relayedSender?: string
  channel?: string
  created?: string
  relayedAt?: string | null
}) {
  const eventId = input.eventId ?? `evt_${randomUUID().replaceAll('-', '')}`
  const receiptId = input.receiptId ?? randomUUID()
  const recipient = input.recipient ?? 'lead@example.test'
  const providerAccountId = input.providerAccountId ?? 'acct_own'
  const data: Record<string, unknown> = {
    original_message_id: input.originalMessageId,
    provider_message_id: input.providerMessageId,
    recipient,
    sender: input.relayedSender ?? 'sender@example.test',
  }
  // `relayedAt: null` models a relay event that genuinely omitted the relay
  // timestamp, which is the only case that may fall back to envelope.created.
  if (input.relayedAt !== null) data.relayed_at = input.relayedAt ?? new Date().toISOString()
  const payload = {
    id: eventId,
    object: 'event',
    type: 'message.relayed',
    created: input.created ?? new Date().toISOString(),
    account_id: providerAccountId,
    data,
  }
  ok(`INSERT INTO public.winnr_ingestion_receipts(id,endpoint_id,organization_id,provider_event_id,fingerprint,payload,channel,created_at)
   VALUES('${receiptId}','${input.endpointId ?? ids.endpoint}','${ids.org}','${eventId}','${input.receiptFingerprint ?? fingerprintB}',${quote(payload)},'${input.channel ?? 'webhook'}',${input.receiptCreatedAt ?? 'now()'})`)
  ok(`INSERT INTO public.winnr_message_id_maps(organization_id,connection_id,provider_account_id,account_id,original_message_id,provider_message_id,recipient)
   VALUES('${ids.org}','${input.connectionId ?? ids.connection}','${providerAccountId}','${input.accountId ?? ids.account}','${input.originalMessageId}','${input.providerMessageId}','${recipient}')`)
  return receiptId
}

function reset() {
  ok(`DROP TRIGGER IF EXISTS reconciliation_fixture_fail_event ON public.outreach_events;
DROP FUNCTION IF EXISTS public.reconciliation_fixture_fail_event();
TRUNCATE public.organizations,auth.users CASCADE;`)
  ok(`INSERT INTO public.organizations(id,name,slug) VALUES('${ids.org}','Fixture','fixture'),('${ids.otherOrg}','Other','other');
INSERT INTO auth.users(id) VALUES('${ids.owner}'),('${ids.admin}'),('${ids.member}'),('${ids.otherOwner}');
INSERT INTO public.users(id,email,organization_id,role) VALUES
 ('${ids.owner}','owner@example.test','${ids.org}','owner'),
 ('${ids.admin}','admin@example.test','${ids.org}','admin'),
 ('${ids.member}','member@example.test','${ids.org}','member'),
 ('${ids.otherOwner}','other@example.test','${ids.otherOrg}','owner');
INSERT INTO public.email_accounts(id,organization_id,email,provider) VALUES('${ids.account}','${ids.org}','sender@example.test','smtp'),('${ids.otherAccount}','${ids.org}','other-sender@example.test','smtp');
INSERT INTO public.winnr_connections(id,organization_id,provider_account_id,token_ciphertext,permissions) VALUES('${ids.connection}','${ids.org}','acct_own','synthetic','["read","write"]');
INSERT INTO public.winnr_ingestion_endpoints(id,organization_id,connection_id,connection_version,provider_account_id,webhook_id,secret_ciphertext,verified_events,associated_at) VALUES('${ids.endpoint}','${ids.org}','${ids.connection}',1,'acct_own','wh', 'synthetic',ARRAY['email.received','message.relayed','email.bounced','email.complained'],now());
INSERT INTO public.winnr_mailbox_credentials(organization_id,connection_id,connection_version,provider_mailbox_id,email,account_id,credentials_ciphertext) VALUES('${ids.org}','${ids.connection}',1,'provider-mailbox','sender@example.test','${ids.account}','synthetic');
INSERT INTO public.campaigns(id,organization_id,name,status,settings) VALUES('${ids.campaign}','${ids.org}','Fixture campaign','active','{"timezone":"UTC"}');
INSERT INTO public.leads(id,organization_id,email,validation_status) VALUES('${ids.lead}','${ids.org}','lead@example.test','valid');
INSERT INTO public.campaign_leads(id,campaign_id,lead_id,status,current_step) VALUES('${ids.enrollment}','${ids.campaign}','${ids.lead}','pending',0);
INSERT INTO public.campaign_sequences(campaign_id,step_number,subject,body_html,body_text,condition_type,delay_days,delay_hours) VALUES('${ids.campaign}',1,'One','','One','always',0,0),('${ids.campaign}',2,'Two','','Two','not_replied',1,0);`)
}

async function reconcile(attemptId: string, fingerprint?: string, actor = ids.owner) {
  return parsed('reconcile', fingerprint ? { attemptId, fingerprint } : { attemptId }, actor)
}

describe.skipIf(!url)('032 verified SMTP reconciliation on real PostgreSQL', () => {
  beforeAll(() => {
    const resetAll = runSqlResult(
      url as string,
      `DROP SCHEMA IF EXISTS public CASCADE;DROP SCHEMA IF EXISTS auth CASCADE;CREATE SCHEMA public;GRANT USAGE ON SCHEMA public TO PUBLIC;
CREATE EXTENSION IF NOT EXISTS pgcrypto;CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE SCHEMA IF NOT EXISTS auth;CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY);
DO $$ BEGIN CREATE ROLE anon;EXCEPTION WHEN duplicate_object THEN NULL;END $$;
DO $$ BEGIN CREATE ROLE authenticated;EXCEPTION WHEN duplicate_object THEN NULL;END $$;
DO $$ BEGIN CREATE ROLE service_role;EXCEPTION WHEN duplicate_object THEN NULL;END $$;`,
    )
    expect(resetAll.code, resetAll.err).toBe(0)
    runSql(url as string, readFileSync('tests/fixtures/baseline-outreach.sql', 'utf8'))
    // Actual additive migrations, including the scheduler wrappers from031.
    // Reconciliation must retain its settlement behavior while outbound is stopped.
    for (const file of [
      '022_campaign_core.sql',
      '020_winnr_connections.sql',
      '021_outreach_event_spine.sql',
      '023_outreach_suppression.sql',
      '025_identity_bootstrap.sql',
      '026_winnr_smtp.sql',
      '024_email_dispatch.sql',
      '027_winnr_ingestion.sql',
      '028_lead_validation.sql',
      '029_email_replies.sql',
      '030_outreach_agents.sql',
      '031_outreach_operations.sql',
      '032_outreach_reconciliation.sql',
    ]) {
      expect(() => runSql(url as string, readFileSync(`supabase/migrations/${file}`, 'utf8'))).not.toThrow()
    }
  })

  beforeEach(() => {
    reset()
  })

  it('accepts an unknown attempt once from exact authenticated relay evidence', async () => {
    insertAttempt({ id: ids.campaignAttempt, kind: 'campaign', status: 'unknown' })
    insertRelay({ originalMessageId: frozenCampaign.messageId as string, providerMessageId: '<relayed-campaign@example.test>' })

    const list = parsed('list', {})
    expect(list.items).toHaveLength(1)
    expect((list.items as Array<Record<string, unknown>>)[0]).toMatchObject({ evidence: 'available', status: 'unknown' })
    expect(list.counts).toMatchObject({ unconfirmed: 1, available: 1, missing: 0, conflicting: 0 })

    const outcome = await reconcile(ids.campaignAttempt, fingerprintA)
    expect(outcome).toMatchObject({ status: 'accepted', alreadyAccepted: false, evidence: 'available' })
    expect(outcome.auditId).toBeTruthy()
    expect(outcome.eventId).toBeTruthy()

    expect(ok('SELECT status FROM public.email_dispatch_attempts')).toBe('accepted')
    expect(ok('SELECT count(*) FROM public.sent_emails')).toBe('1')
    expect(ok('SELECT body_text FROM public.sent_emails')).toBe('Frozen campaign body')
    expect(ok('SELECT current_step||\'|\'||status FROM public.campaign_leads')).toBe('1|in_progress')
    expect(ok('SELECT count(*) FROM public.outreach_reconciliation_audit')).toBe('1')
    expect(ok('SELECT status_before||\'|\'||provider_message_id FROM public.outreach_reconciliation_audit')).toBe('unknown|<relayed-campaign@example.test>')
    expect(ok('SELECT type||\'|\'||source FROM public.outreach_events')).toBe('outreach.dispatch.reconciled|outreach.reconciliation')

    const again = await reconcile(ids.campaignAttempt)
    expect(again).toMatchObject({ status: 'accepted', alreadyAccepted: true })
    expect(ok('SELECT count(*) FROM public.sent_emails')).toBe('1')
    expect(ok('SELECT count(*) FROM public.outreach_reconciliation_audit')).toBe('1')
    expect(ok('SELECT count(*) FROM public.outreach_events')).toBe('1')
  })

  it('returns idempotently when the transport already accepted the attempt', async () => {
    insertAttempt({ id: ids.campaignAttempt, kind: 'campaign', status: 'accepted' })
    ok(`INSERT INTO public.sent_emails(id,organization_id,campaign_id,campaign_lead_id,lead_id,email_account_id,from_email,to_email,subject,message_id,status,sent_at) VALUES('${ids.campaignAttempt}','${ids.org}','${ids.campaign}','${ids.enrollment}','${ids.lead}','${ids.account}','sender@example.test','lead@example.test','Frozen campaign','${frozenCampaign.messageId}','sent',now())`)
    const outcome = await reconcile(ids.campaignAttempt, fingerprintA)
    expect(outcome).toMatchObject({ status: 'accepted', alreadyAccepted: true })
    expect(outcome.auditId).toBeNull()
    expect(ok('SELECT count(*) FROM public.outreach_reconciliation_audit')).toBe('0')
    expect(ok('SELECT count(*) FROM public.sent_emails')).toBe('1')
  })

  it('keeps an unknown hold when no authenticated receipt matches', async () => {
    insertAttempt({ id: ids.campaignAttempt, kind: 'campaign', status: 'unknown' })
    const outcome = await reconcile(ids.campaignAttempt)
    expect(outcome).toMatchObject({ status: 'held', reason: 'evidence_missing' })
    expect(ok('SELECT status FROM public.email_dispatch_attempts')).toBe('unknown')
    expect(ok('SELECT count(*) FROM public.sent_emails')).toBe('0')
    expect(ok('SELECT count(*) FROM public.outreach_reconciliation_audit')).toBe('0')
    expect(ok('SELECT count(*) FROM public.outreach_events')).toBe('0')
  })

  it.each([
    ['wrong recipient', { recipient: 'someone@example.test' }],
    ['wrong canonical account', { accountId: ids.otherAccount }],
    ['wrong provider account', { providerAccountId: 'acct_foreign' }],
    ['wrong relayed sender', { relayedSender: 'attacker@example.test' }],
  ])('rejects %s evidence and leaves the attempt held', async (_label, overrides) => {
    insertAttempt({ id: ids.campaignAttempt, kind: 'campaign', status: 'unknown' })
    insertRelay({ originalMessageId: frozenCampaign.messageId as string, providerMessageId: '<relayed-mismatch@example.test>', ...overrides })
    const outcome = await reconcile(ids.campaignAttempt)
    expect(outcome.status).toBe('held')
    expect(ok('SELECT status FROM public.email_dispatch_attempts')).toBe('unknown')
    expect(ok('SELECT count(*) FROM public.sent_emails')).toBe('0')
  })

  it('rejects an unrelated frozen message id', async () => {
    insertAttempt({ id: ids.campaignAttempt, kind: 'campaign', status: 'unknown' })
    insertRelay({ originalMessageId: '<different@example.test>', providerMessageId: '<relayed-other@example.test>' })
    expect((await reconcile(ids.campaignAttempt)).status).toBe('held')
    expect(ok('SELECT status FROM public.email_dispatch_attempts')).toBe('unknown')
  })

  it('rejects ambiguous multiple mappings for the same frozen message', async () => {
    insertAttempt({ id: ids.campaignAttempt, kind: 'campaign', status: 'unknown' })
    insertRelay({ originalMessageId: frozenCampaign.messageId as string, providerMessageId: '<relayed-one@example.test>' })
    insertRelay({ originalMessageId: frozenCampaign.messageId as string, providerMessageId: '<relayed-two@example.test>' })
    const outcome = await reconcile(ids.campaignAttempt)
    expect(outcome).toMatchObject({ status: 'held', reason: 'evidence_conflicting' })
    const counts = parsed('list', {}).counts as Record<string, number>
    expect(counts).toMatchObject({ held: 1, conflicting: 1, available: 0 })
    expect(ok('SELECT status FROM public.email_dispatch_attempts')).toBe('unknown')
  })

  it('never accepts another provider account with identical ids after reconnect', async () => {
    insertAttempt({ id: ids.campaignAttempt, kind: 'campaign', status: 'unknown' })
    // Same-provider reconnect: the old connection is retired (its endpoint keeps
    // the original provider account) and a new connection is bound to a
    // different provider account with the same message ids and recipient.
    ok(`DELETE FROM public.winnr_connections WHERE id='${ids.connection}'`)
    ok(`INSERT INTO public.winnr_connections(id,organization_id,provider_account_id,token_ciphertext,permissions) VALUES('${ids.otherConnection}','${ids.org}','acct_other','synthetic','["read","write"]')`)
    ok(`INSERT INTO public.winnr_ingestion_endpoints(id,organization_id,connection_id,connection_version,provider_account_id,webhook_id,secret_ciphertext) VALUES('${ids.otherEndpoint}','${ids.org}','${ids.otherConnection}',1,'acct_other','wh2','synthetic')`)
    insertRelay({
      originalMessageId: frozenCampaign.messageId as string,
      providerMessageId: '<relayed-foreign-account@example.test>',
      providerAccountId: 'acct_other',
      endpointId: ids.otherEndpoint,
      connectionId: ids.otherConnection,
    })
    const outcome = await reconcile(ids.campaignAttempt)
    expect(outcome.status).toBe('held')
    expect(ok('SELECT status FROM public.email_dispatch_attempts')).toBe('unknown')
  })

  it('does not prove an attempt from a retained different connection-version provider account', async () => {
    insertAttempt({ id: ids.campaignAttempt, kind: 'campaign', status: 'unknown', connectionVersion: 2 })
    ok(`INSERT INTO public.winnr_ingestion_endpoints(id,organization_id,connection_id,connection_version,provider_account_id) VALUES('${ids.endpointV2}','${ids.org}','${ids.connection}',2,'acct_different')`)
    // Version1 evidence belongs to the retained acct_own endpoint, never to the
    // version2 attempt that was authorized under acct_different.
    insertRelay({ originalMessageId: frozenCampaign.messageId as string, providerMessageId: '<relayed-wrong-version@example.test>' })
    const listed = parsed('list', {}) as { counts: Record<string, number> }
    expect(listed.counts).toMatchObject({ missing: 1, available: 0, conflicting: 0 })
    expect(await reconcile(ids.campaignAttempt)).toMatchObject({ status: 'held', reason: 'evidence_missing' })
    expect(ok('SELECT status FROM public.email_dispatch_attempts')).toBe('unknown')
    expect(ok('SELECT count(*) FROM public.sent_emails')).toBe('0')
  })

  it('keeps exactly one same-provider candidate across a token rotation and accepts once', async () => {
    ok(`INSERT INTO public.winnr_ingestion_endpoints(id,organization_id,connection_id,connection_version,provider_account_id) VALUES('${ids.endpointV2}','${ids.org}','${ids.connection}',2,'acct_own')`)
    insertAttempt({ id: ids.campaignAttempt, kind: 'campaign', status: 'unknown', connectionVersion: 1 })
    // The buggy join matched both the v1 and v2 endpoints and doubled this one receipt.
    insertRelay({ originalMessageId: frozenCampaign.messageId as string, providerMessageId: '<relayed-rotated@example.test>' })
    expect(ok(`SELECT count(*) FROM public.outreach_reconciliation_candidates('${ids.org}','${ids.campaignAttempt}')`)).toBe('1')
    const listed = parsed('list', {}) as { counts: Record<string, number> }
    expect(listed.counts).toMatchObject({ available: 1, conflicting: 0 })
    expect((await reconcile(ids.campaignAttempt, fingerprintA)).status).toBe('accepted')
    expect(ok('SELECT count(*) FROM public.sent_emails')).toBe('1')
  })

  it('accepts a same-provider receipt ingested under the current endpoint after rotation', async () => {
    ok(`INSERT INTO public.winnr_ingestion_endpoints(id,organization_id,connection_id,connection_version,provider_account_id) VALUES('${ids.endpointV2}','${ids.org}','${ids.connection}',2,'acct_own')`)
    insertAttempt({ id: ids.campaignAttempt, kind: 'campaign', status: 'unknown', connectionVersion: 1 })
    insertRelay({
      originalMessageId: frozenCampaign.messageId as string,
      providerMessageId: '<relayed-later-endpoint@example.test>',
      endpointId: ids.endpointV2,
    })
    expect((await reconcile(ids.campaignAttempt)).status).toBe('accepted')
  })

  it('rejects evidence bound to the provider account the connection rotated to', async () => {
    ok(`INSERT INTO public.winnr_ingestion_endpoints(id,organization_id,connection_id,connection_version,provider_account_id) VALUES('${ids.endpointV2}','${ids.org}','${ids.connection}',2,'acct_different')`)
    insertAttempt({ id: ids.campaignAttempt, kind: 'campaign', status: 'unknown', connectionVersion: 1 })
    insertRelay({
      originalMessageId: frozenCampaign.messageId as string,
      providerMessageId: '<relayed-rotated-account@example.test>',
      providerAccountId: 'acct_different',
      endpointId: ids.endpointV2,
    })
    expect(await reconcile(ids.campaignAttempt)).toMatchObject({ status: 'held' })
    expect(ok('SELECT status FROM public.email_dispatch_attempts')).toBe('unknown')
  })

  it('reconciles a reply across a same-provider token rotation', async () => {
    ok(`INSERT INTO public.threads(id,organization_id,mailbox_id,subject,participant_email,campaign_id,lead_id) VALUES('${ids.thread}','${ids.org}','${ids.account}','Incoming','lead@example.test','${ids.campaign}','${ids.lead}');
INSERT INTO public.replies(id,organization_id,thread_id,email_account_id,lead_id,from_email,to_email,subject,body_text,message_id,received_at) VALUES('${ids.sourceReply}','${ids.org}','${ids.thread}','${ids.account}','${ids.lead}','lead@example.test','sender@example.test','Incoming','Question','<incoming@example.test>',now());`);
    ok(`INSERT INTO public.winnr_ingestion_endpoints(id,organization_id,connection_id,connection_version,provider_account_id) VALUES('${ids.endpointV2}','${ids.org}','${ids.connection}',2,'acct_own')`)
    insertAttempt({ id: ids.replyAttempt, kind: 'reply', status: 'unknown', threadId: ids.thread, sourceReplyId: ids.sourceReply, connectionVersion: 2 })
    insertRelay({ originalMessageId: frozenReply.messageId as string, providerMessageId: '<relayed-reply-rotated@example.test>', endpointId: ids.endpointV2 })
    expect((await reconcile(ids.replyAttempt)).status).toBe('accepted')
    expect(ok(`SELECT thread_id FROM public.thread_messages WHERE id='${ids.replyAttempt}'`)).toBe(ids.thread)
  })

  it('holds a reply when its exact connection version maps to a different provider account', async () => {
    ok(`INSERT INTO public.threads(id,organization_id,mailbox_id,subject,participant_email,campaign_id,lead_id) VALUES('${ids.thread}','${ids.org}','${ids.account}','Incoming','lead@example.test','${ids.campaign}','${ids.lead}');
INSERT INTO public.replies(id,organization_id,thread_id,email_account_id,lead_id,from_email,to_email,subject,body_text,message_id,received_at) VALUES('${ids.sourceReply}','${ids.org}','${ids.thread}','${ids.account}','${ids.lead}','lead@example.test','sender@example.test','Incoming','Question','<incoming@example.test>',now());`);
    ok(`INSERT INTO public.winnr_ingestion_endpoints(id,organization_id,connection_id,connection_version,provider_account_id) VALUES('${ids.endpointV2}','${ids.org}','${ids.connection}',2,'acct_different')`)
    insertAttempt({ id: ids.replyAttempt, kind: 'reply', status: 'unknown', threadId: ids.thread, sourceReplyId: ids.sourceReply, connectionVersion: 2 })
    insertRelay({ originalMessageId: frozenReply.messageId as string, providerMessageId: '<relayed-reply-wrong-version@example.test>' })
    expect((await reconcile(ids.replyAttempt)).status).toBe('held')
    expect(ok('SELECT status FROM public.email_dispatch_attempts')).toBe('unknown')
  })

  it('denies a foreign tenant and ordinary members before any effect', async () => {
    insertAttempt({ id: ids.campaignAttempt, kind: 'campaign', status: 'unknown' })
    insertRelay({ originalMessageId: frozenCampaign.messageId as string, providerMessageId: '<relayed@example.test>' })
    expect(call('reconcile', { attemptId: ids.campaignAttempt }, ids.member).code).toBe(1)
    expect(call('reconcile', { attemptId: ids.campaignAttempt }, ids.otherOwner, ids.otherOrg).code).toBe(1)
    expect(ok('SELECT status FROM public.email_dispatch_attempts')).toBe('unknown')
    expect(ok('SELECT count(*) FROM public.sent_emails')).toBe('0')
  })

  it('allows a current owner to reconcile an attempt whose original actor was removed, attributed separately', async () => {
    insertAttempt({ id: ids.campaignAttempt, kind: 'campaign', status: 'unknown', actorId: ids.removedActor })
    insertRelay({ originalMessageId: frozenCampaign.messageId as string, providerMessageId: '<relayed-removed@example.test>' })
    const outcome = await reconcile(ids.campaignAttempt, undefined, ids.admin)
    expect(outcome.status).toBe('accepted')
    expect(ok('SELECT actor_id FROM public.email_dispatch_attempts')).toBe(ids.removedActor)
    expect(ok('SELECT reconciled_by FROM public.outreach_reconciliation_audit')).toBe(ids.admin)
  })

  it('holds a live handoff and accepts the same attempt once its lease has expired', async () => {
    insertAttempt({ id: ids.campaignAttempt, kind: 'campaign', status: 'dispatching', leaseAt: "now()+interval '5 minutes'" })
    insertRelay({ originalMessageId: frozenCampaign.messageId as string, providerMessageId: '<relayed-live@example.test>' })
    expect(await reconcile(ids.campaignAttempt)).toMatchObject({ status: 'held', reason: 'handoff_active' })
    expect(ok('SELECT status FROM public.email_dispatch_attempts')).toBe('dispatching')
    ok("UPDATE public.email_dispatch_attempts SET lease_expires_at=now()-interval '1 second'")
    expect((await reconcile(ids.campaignAttempt)).status).toBe('accepted')
  })

  it.each([
    ['reserved', 'pre_effect_reservation'],
    ['rejected', 'not_proof_of_send'],
    ['cancelled', 'not_proof_of_send'],
  ])('does not treat a %s attempt as proof of send', async (status, reason) => {
    insertAttempt({
      id: ids.campaignAttempt,
      kind: 'campaign',
      status,
      authorizedAt: status === 'reserved' ? null : undefined,
    })
    insertRelay({ originalMessageId: frozenCampaign.messageId as string, providerMessageId: '<relayed-state@example.test>' })
    expect(await reconcile(ids.campaignAttempt)).toMatchObject({ status: 'held', reason })
    expect(ok('SELECT status FROM public.email_dispatch_attempts')).toBe(status)
    expect(ok('SELECT count(*) FROM public.sent_emails')).toBe('0')
  })

  it('retains replied state, campaign pause and the kill switch without resuming anything', async () => {
    insertAttempt({ id: ids.campaignAttempt, kind: 'campaign', status: 'unknown' })
    insertRelay({ originalMessageId: frozenCampaign.messageId as string, providerMessageId: '<relayed-retained@example.test>' })
    ok(`UPDATE public.campaign_leads SET status='replied',next_send_at=NULL WHERE id='${ids.enrollment}';
UPDATE public.campaigns SET status='paused' WHERE id='${ids.campaign}';
INSERT INTO public.email_dispatch_config(campaign_id,organization_id,sender_name,sender_company,business_address,sender_email,mailbox_id,mailbox_daily_limit,connection_id,connection_version,killed) VALUES('${ids.campaign}','${ids.org}','Name','Co','Addr','sender@example.test','provider-mailbox',5,'${ids.connection}',1,true);`)
    expect((await reconcile(ids.campaignAttempt)).status).toBe('accepted')
    expect(ok('SELECT status FROM public.campaign_leads')).toBe('replied')
    expect(ok('SELECT status FROM public.campaigns')).toBe('paused')
    expect(ok('SELECT killed FROM public.email_dispatch_config')).toBe('t')
  })

  it('resolves a reply alias to the canonical thread and creates no second source response', async () => {
    ok(`INSERT INTO public.threads(id,organization_id,mailbox_id,subject,participant_email,campaign_id,lead_id) VALUES('${ids.thread}','${ids.org}','${ids.account}','Incoming','lead@example.test','${ids.campaign}','${ids.lead}');
INSERT INTO public.threads(id,organization_id,mailbox_id,subject,participant_email,campaign_id,lead_id) VALUES('${ids.aliasThread}','${ids.org}','${ids.account}','Incoming','lead@example.test','${ids.campaign}','${ids.lead}');
INSERT INTO public.outreach_conversation_controls(organization_id,thread_id,updated_by,merged_into_thread_id) VALUES('${ids.org}','${ids.aliasThread}','${ids.owner}','${ids.thread}');
INSERT INTO public.replies(id,organization_id,thread_id,email_account_id,lead_id,from_email,to_email,subject,body_text,message_id,received_at) VALUES('${ids.sourceReply}','${ids.org}','${ids.thread}','${ids.account}','${ids.lead}','lead@example.test','sender@example.test','Incoming','Question','<incoming@example.test>',now());`)
    insertAttempt({ id: ids.replyAttempt, kind: 'reply', status: 'unknown', threadId: ids.aliasThread, sourceReplyId: ids.sourceReply })
    insertRelay({ originalMessageId: frozenReply.messageId as string, providerMessageId: '<relayed-reply@example.test>' })
    const outcome = await reconcile(ids.replyAttempt)
    expect(outcome).toMatchObject({ status: 'accepted', kind: 'reply' })
    expect(ok(`SELECT thread_id FROM public.thread_messages WHERE id='${ids.replyAttempt}'`)).toBe(ids.thread)
    expect(ok(`SELECT thread_id FROM public.email_dispatch_attempts WHERE id='${ids.replyAttempt}'`)).toBe(ids.aliasThread)
    expect(ok(`SELECT count(*) FROM public.thread_messages WHERE id='${ids.replyAttempt}'`)).toBe('1')
    expect(ok(`SELECT count(*) FROM public.email_dispatch_attempts WHERE kind='reply' AND source_reply_id='${ids.sourceReply}' AND status<>'cancelled'`)).toBe('1')
    expect(ok(`SELECT count(*) FROM public.sent_emails WHERE id='${ids.replyAttempt}'`)).toBe('1')
    const again = await reconcile(ids.replyAttempt)
    expect(again).toMatchObject({ status: 'accepted', alreadyAccepted: true })
    expect(ok(`SELECT count(*) FROM public.thread_messages WHERE id='${ids.replyAttempt}'`)).toBe('1')
  })

  it('correlates a received reply that arrived before reconciliation', async () => {
    ok(`INSERT INTO public.threads(id,organization_id,mailbox_id,subject,participant_email,campaign_id,lead_id) VALUES('${ids.thread}','${ids.org}','${ids.account}','Incoming','lead@example.test','${ids.campaign}','${ids.lead}');
INSERT INTO public.replies(id,organization_id,thread_id,email_account_id,lead_id,from_email,to_email,subject,body_text,message_id,received_at) VALUES('${ids.sourceReply}','${ids.org}','${ids.thread}','${ids.account}','${ids.lead}','lead@example.test','sender@example.test','Incoming','Question','<incoming@example.test>',now());`)
    insertAttempt({ id: ids.replyAttempt, kind: 'reply', status: 'unknown', threadId: ids.thread, sourceReplyId: ids.sourceReply })
    insertRelay({ originalMessageId: frozenReply.messageId as string, providerMessageId: '<relayed-reply@example.test>' })
    // Inbound reply references the still-held outbound provider id.
    const receive = ok(`SELECT public.winnr_receive_event('${ids.endpoint}',${quote({
      id: 'evt_received_before',
      object: 'event',
      type: 'email.received',
      created: '2026-10-05T00:00:00.000Z',
      account_id: 'acct_own',
      data: {
        mailbox: 'sender@example.test',
        from: 'lead@example.test',
        subject: 'Follow up',
        message_id: '<received-before@example.test>',
        in_reply_to: '<relayed-reply@example.test>',
        received_at: '2026-10-05T00:00:00.000Z',
      },
    })},'${'c'.repeat(64)}')`)
    expect(receive).toContain('duplicate')
    const temporary = ok(`SELECT thread_id FROM public.replies WHERE message_id='<received-before@example.test>'`)
    expect(temporary).not.toBe(ids.thread)
    expect((await reconcile(ids.replyAttempt)).status).toBe('accepted')
    expect(ok(`SELECT thread_id FROM public.replies WHERE message_id='<received-before@example.test>'`)).toBe(ids.thread)
    expect(ok(`SELECT status FROM public.sent_emails WHERE id='${ids.replyAttempt}'`)).toBe('replied')
  })

  it('rolls the whole transaction back when the canonical event cannot be persisted', async () => {
    insertAttempt({ id: ids.campaignAttempt, kind: 'campaign', status: 'unknown' })
    insertRelay({ originalMessageId: frozenCampaign.messageId as string, providerMessageId: '<relayed-rollback@example.test>' })
    ok(`CREATE FUNCTION public.reconciliation_fixture_fail_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture rejection'; END $$;
CREATE TRIGGER reconciliation_fixture_fail_event BEFORE INSERT ON public.outreach_events FOR EACH ROW EXECUTE FUNCTION public.reconciliation_fixture_fail_event();`)
    const failed = call('reconcile', { attemptId: ids.campaignAttempt, fingerprint: fingerprintA })
    expect(failed.code).toBe(1)
    expect(ok('SELECT status FROM public.email_dispatch_attempts')).toBe('unknown')
    expect(ok('SELECT count(*) FROM public.sent_emails')).toBe('0')
    expect(ok('SELECT count(*) FROM public.outreach_reconciliation_audit')).toBe('0')
    expect(ok('SELECT count(*) FROM public.outreach_events')).toBe('0')
  })

  it('keeps the reconciliation audit immutable', async () => {
    insertAttempt({ id: ids.campaignAttempt, kind: 'campaign', status: 'unknown' })
    insertRelay({ originalMessageId: frozenCampaign.messageId as string, providerMessageId: '<relayed-audit@example.test>' })
    expect((await reconcile(ids.campaignAttempt)).status).toBe('accepted')
    expect(result(`UPDATE public.outreach_reconciliation_audit SET recipient='tampered@example.test'`).code).toBe(1)
    expect(result('DELETE FROM public.outreach_reconciliation_audit').code).toBe(1)
    expect(ok('SELECT recipient FROM public.outreach_reconciliation_audit')).toBe('lead@example.test')
  })

  it('holds a future authenticated provider time with recent arrival and stays consistent on list/status', async () => {
    insertAttempt({ id: ids.campaignAttempt, kind: 'campaign', status: 'unknown' })
    insertRelay({
      originalMessageId: frozenCampaign.messageId as string,
      providerMessageId: '<relayed-future@example.test>',
      relayedAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
      receiptCreatedAt: 'now()',
    })
    const outcome = await reconcile(ids.campaignAttempt)
    expect(outcome).toMatchObject({ status: 'held', reason: 'evidence_timestamp', evidence: 'conflicting' })
    const listed = parsed('list', {}) as { items: Array<Record<string, unknown>>; counts: Record<string, number> }
    expect(listed.items[0]).toMatchObject({ evidence: 'conflicting' })
    expect(listed.counts).toMatchObject({ available: 0, conflicting: 1 })
    expect(parsed('status', { attemptId: ids.campaignAttempt })).toMatchObject({ canReconcile: false, evidence: 'conflicting' })
    expect(ok('SELECT status FROM public.email_dispatch_attempts')).toBe('unknown')
  })

  it('holds a provider time before the attempt was authorized even with recent arrival', async () => {
    insertAttempt({
      id: ids.campaignAttempt,
      kind: 'campaign',
      status: 'unknown',
      createdAt: "now()-interval '3 hours'",
      authorizedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    })
    insertRelay({
      originalMessageId: frozenCampaign.messageId as string,
      providerMessageId: '<relayed-pre-attempt@example.test>',
      relayedAt: new Date(Date.now() - 3.5 * 60 * 60 * 1000).toISOString(),
      receiptCreatedAt: 'now()',
    })
    expect(await reconcile(ids.campaignAttempt)).toMatchObject({ status: 'held', reason: 'evidence_timestamp' })
    expect(ok('SELECT status FROM public.email_dispatch_attempts')).toBe('unknown')
  })

  it('accepts a legitimate provider event that reached the ledger late', async () => {
    insertAttempt({
      id: ids.campaignAttempt,
      kind: 'campaign',
      status: 'unknown',
      createdAt: "now()-interval '3 hours'",
      authorizedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    })
    insertRelay({
      originalMessageId: frozenCampaign.messageId as string,
      providerMessageId: '<relayed-delayed@example.test>',
      relayedAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
      receiptCreatedAt: 'now()',
    })
    expect((await reconcile(ids.campaignAttempt)).status).toBe('accepted')
  })

  it('holds a malformed supplied relay time instead of failing or silently falling back', async () => {
    insertAttempt({ id: ids.campaignAttempt, kind: 'campaign', status: 'unknown' })
    insertRelay({
      originalMessageId: frozenCampaign.messageId as string,
      providerMessageId: '<relayed-malformed@example.test>',
      relayedAt: 'not-a-timestamp',
      created: new Date().toISOString(),
    })
    // The malformed private fixture must not abort the whole list/status page.
    const listed = parsed('list', {}) as { items: Array<Record<string, unknown>>; counts: Record<string, number> }
    expect(listed.items[0]).toMatchObject({ evidence: 'conflicting' })
    expect(listed.counts).toMatchObject({ available: 0, conflicting: 1 })
    expect(parsed('status', { attemptId: ids.campaignAttempt })).toMatchObject({ canReconcile: false, evidence: 'conflicting' })
    expect((await reconcile(ids.campaignAttempt)).reason).toBe('evidence_timestamp')
    expect(ok('SELECT status FROM public.email_dispatch_attempts')).toBe('unknown')
  })

  it('falls back to the signed envelope created time only when the relay time is absent', async () => {
    insertAttempt({ id: ids.campaignAttempt, kind: 'campaign', status: 'unknown' })
    insertRelay({
      originalMessageId: frozenCampaign.messageId as string,
      providerMessageId: '<relayed-fallback@example.test>',
      relayedAt: null,
      created: new Date(Date.now() - 60 * 1000).toISOString(),
    })
    expect((await reconcile(ids.campaignAttempt)).status).toBe('accepted')
  })

  it('audits the immutable provider event time and the local arrival separately', async () => {
    insertAttempt({ id: ids.campaignAttempt, kind: 'campaign', status: 'unknown' })
    const providerAt = new Date(Date.now() - 2 * 60 * 1000).toISOString()
    insertRelay({
      originalMessageId: frozenCampaign.messageId as string,
      providerMessageId: '<relayed-audit-time@example.test>',
      relayedAt: providerAt,
      receiptCreatedAt: 'now()',
    })
    expect((await reconcile(ids.campaignAttempt)).status).toBe('accepted')
    const row = JSON.parse(ok(`SELECT jsonb_build_object('providerAt',source_receipt_at,'arrivalAt',source_receipt_arrival_at) FROM public.outreach_reconciliation_audit`)) as { providerAt: string; arrivalAt: string }
    expect(new Date(row.providerAt).toISOString()).toBe(providerAt)
    expect(new Date(row.arrivalAt).getTime()).toBeGreaterThan(new Date(row.providerAt).getTime())
  })

  it('advances exactly once under concurrent reconciliation calls', async () => {
    insertAttempt({ id: ids.campaignAttempt, kind: 'campaign', status: 'unknown' })
    insertRelay({ originalMessageId: frozenCampaign.messageId as string, providerMessageId: '<relayed-concurrent@example.test>' })
    const statement = `SELECT public.outreach_reconciliation_mutate('${ids.owner}','${ids.org}','reconcile',${quote({ attemptId: ids.campaignAttempt, fingerprint: fingerprintA })})`
    const [a, b] = await Promise.all([sqlAsync(statement), sqlAsync(statement)])
    expect(a.code, a.err).toBe(0)
    expect(b.code, b.err).toBe(0)
    const outcomes = [JSON.parse(a.out), JSON.parse(b.out)] as Array<Record<string, unknown>>
    expect(outcomes.filter((entry) => entry.alreadyAccepted === false)).toHaveLength(1)
    expect(outcomes.filter((entry) => entry.alreadyAccepted === true)).toHaveLength(1)
    expect(ok('SELECT count(*) FROM public.sent_emails')).toBe('1')
    expect(ok('SELECT count(*) FROM public.outreach_reconciliation_audit')).toBe('1')
    expect(ok('SELECT count(*) FROM public.outreach_events')).toBe('1')
  })

  it('denies browser roles the reconciliation RPC and private helpers', () => {
    for (const role of ['anon', 'authenticated']) {
      expect(result(`SET ROLE ${role};SELECT public.outreach_reconciliation_mutate('${ids.owner}','${ids.org}','list','{}')`).code).toBe(1)
      expect(result(`SET ROLE ${role};SELECT public.outreach_reconciliation_candidates('${ids.org}','${ids.campaignAttempt}')`).code).toBe(1)
      expect(result(`SET ROLE ${role};SELECT public.outreach_reconciliation_event_time('{}'::jsonb)`).code).toBe(1)
      expect(result(`SET ROLE ${role};SELECT public.outreach_canonical_reply_thread('${ids.org}','${ids.thread}')`).code).toBe(1)
    }
    expect(result(`SET ROLE service_role;SELECT public.outreach_reconciliation_candidates('${ids.org}','${ids.campaignAttempt}')`).code).toBe(1)
    expect(result(`SET ROLE service_role;SELECT public.outreach_reconciliation_event_time('{}'::jsonb)`).code).toBe(1)
    expect(result(`SET ROLE service_role;SELECT public.outreach_reconciliation_mutate('${ids.owner}','${ids.org}','list','{}')`).code).toBe(0)
  })

  it('reports a status view that distinguishes actionable from held attempts', async () => {
    insertAttempt({ id: ids.campaignAttempt, kind: 'campaign', status: 'unknown' })
    insertRelay({ originalMessageId: frozenCampaign.messageId as string, providerMessageId: '<relayed-status@example.test>' })
    const status = parsed('status', { attemptId: ids.campaignAttempt })
    expect(status).toMatchObject({ canReconcile: true, evidence: 'available', reason: null, status: 'unknown' })
    ok("UPDATE public.email_dispatch_attempts SET fingerprint=repeat('d',64)")
    const stale = parsed('status', { attemptId: ids.campaignAttempt })
    expect(stale.canReconcile).toBe(true)
    expect((await reconcile(ids.campaignAttempt, fingerprintA)).reason).toBe('fingerprint_mismatch')
    expect(await reconcile(ids.campaignAttempt, 'd'.repeat(64))).toMatchObject({ status: 'accepted' })
  })
})
