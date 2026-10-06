/**
 * Real PostgreSQL proof for 033 bounded downstream outreach.
 *
 * Installs the committed baseline plus the actual additive migrations 020-033
 * and exercises the real SECURITY DEFINER RPCs. No provider or network call is
 * made: credentials are synthetic ciphertext and effects are only reserved
 * (never executed against a live provider).
 *
 * Safety: the only target is an explicit OUTREACH_DOWNSTREAM_TEST_DATABASE_URL
 * pointing at postgres://127.0.0.1:55439/outreach_downstream_test. It is
 * validated before any DDL, libpq PG* variables are stripped, and no
 * production Supabase variable is read.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { encrypt } from '@/lib/encryption'
import { executeReservedEffect, initiateRequestedCallback, reserveDecisionEffects } from '@/lib/outreach/downstream/scheduler'
import { cancelAppointment, rescheduleAppointment } from '@/lib/outreach/downstream/service'
import { createGhlPort, createCloseBotPort, createRetellPort } from '@/lib/outreach/downstream/providers'
import { downstreamReadSchema, effectContextSchema, connectionSecretSchema } from '@/lib/outreach/downstream/core'
import type { DownstreamRepository } from '@/lib/outreach/downstream/database'
import type { DownstreamWorkerDeps } from '@/lib/outreach/downstream/runtime'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { requireSafeFixtureUrl, runSql, runSqlResult } from '../helpers/postgres-fixture'

const ENV_NAME = 'OUTREACH_DOWNSTREAM_TEST_DATABASE_URL'
const DATABASE = 'outreach_downstream_test'
const rawUrl = process.env[ENV_NAME]
const fixture = rawUrl ? requireSafeFixtureUrl(ENV_NAME, DATABASE) : null
const url = fixture?.url

const ids = {
  org: '11111111-1111-4111-8111-111111111111',
  otherOrg: '11111111-1111-4111-8111-111111111112',
  owner: '22222222-2222-4222-8222-222222222221',
  member: '22222222-2222-4222-8222-222222222223',
  otherOwner: '22222222-2222-4222-8222-222222222224',
  account: '55555555-5555-4555-8555-555555555555',
  campaign: '66666666-6666-4666-8666-666666666666',
  lead: '77777777-7777-4777-8777-777777777777',
  otherLead: '77777777-7777-4777-8777-777777777778',
  thread: '99999999-9999-4999-8999-999999999991',
  sourceReply: '99999999-9999-4999-8999-999999999993',
  decision: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  otherDecision: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
}

function result(statement: string) {
  return runSqlResult(url as string, statement)
}
function ok(statement: string): string {
  const r = result(statement)
  if (r.code !== 0) throw new Error(r.err || r.out)
  return r.out
}
const quote = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`

function call(action: string, payload: Record<string, unknown>, actor = ids.owner, org = ids.org) {
  return result(`SELECT public.outreach_downstream_mutate('${actor}','${org}','${action}',${quote(payload)})`)
}
function parsed(action: string, payload: Record<string, unknown>, actor = ids.owner, org = ids.org) {
  const r = call(action, payload, actor, org)
  expect(r.code, r.err).toBe(0)
  return JSON.parse(r.out) as Record<string, unknown>
}
function effect(action: string, payload: Record<string, unknown>, org = ids.org) {
  return result(`SELECT public.outreach_downstream_effect('${org}','${action}',${quote(payload)})`)
}
function parsedEffect(action: string, payload: Record<string, unknown>, org = ids.org) {
  const r = effect(action, payload, org)
  expect(r.code, r.err).toBe(0)
  return JSON.parse(r.out) as Record<string, unknown>
}

function beginWrite(kind:string,subjectId:unknown,payload:Record<string,unknown>,extra:Record<string,unknown>={}) {
 const payloadText=JSON.stringify(payload),fingerprint=createHash('sha256').update(payloadText).digest('hex')
 return parsedEffect('beginWrite',{kind,subjectId,actorId:ids.owner,connectionRevision:2,payloadText,fingerprint,...extra})
}
function grantWrite(kind:string,subjectId:unknown,payload:Record<string,unknown>,extra:Record<string,unknown>={}) {
 const grant=beginWrite(kind,subjectId,payload,extra);expect(grant.allowed,JSON.stringify(grant)).toBe(true)
 expect(parsedEffect('authorizeWrite',grant).allowed).toBe(true);return grant
}
function callbackPayload(callbackId:unknown) { return {fromNumber:'+14155550999',toNumber:'+14155550100',idempotencyKey:callbackId,metadata:{callbackId,organizationId:ids.org}} }
function bookingPayload(startAt:string) { return {locationId:'loc_1',calendarId:'cal_1',contactId:'ghl_contact_1',startAt,timezone:'UTC'} }
function saveConnection(provider: string, expectedRevision: number, ciphertext: string | null, config: Record<string, unknown>) {
  return parsed('saveConnection', { provider, expectedRevision, ...(ciphertext ? { ciphertext } : {}), config })
}

function reset() {
  ok(`TRUNCATE public.organizations,auth.users CASCADE;`)
  ok(`INSERT INTO public.organizations(id,name,slug) VALUES('${ids.org}','Fixture','fixture'),('${ids.otherOrg}','Other','other');
INSERT INTO auth.users(id) VALUES('${ids.owner}'),('${ids.member}'),('${ids.otherOwner}');
INSERT INTO public.users(id,email,organization_id,role) VALUES
 ('${ids.owner}','owner@example.test','${ids.org}','owner'),
 ('${ids.member}','member@example.test','${ids.org}','member'),
 ('${ids.otherOwner}','other@example.test','${ids.otherOrg}','owner');
INSERT INTO public.campaigns(id,organization_id,name,status,settings) VALUES('${ids.campaign}','${ids.org}','Fixture','active','{"timezone":"UTC"}');
INSERT INTO public.email_accounts(id,organization_id,email,provider) VALUES('${ids.account}','${ids.org}','sender@example.test','smtp');
INSERT INTO public.leads(id,organization_id,email,phone,validation_status) VALUES
 ('${ids.lead}','${ids.org}','lead@example.test','+14155550100','valid'),
 ('${ids.otherLead}','${ids.otherOrg}','other@example.test','+14155550199','valid');
INSERT INTO public.threads(id,organization_id,mailbox_id,subject,participant_email) VALUES('${ids.thread}','${ids.org}','${ids.account}','Fixture','lead@example.test');
INSERT INTO public.replies(id,organization_id,thread_id,lead_id,from_email,to_email,body_text) VALUES('${ids.sourceReply}','${ids.org}','${ids.thread}','${ids.lead}','lead@example.test','sender@example.test','Here is the original inbound body');
INSERT INTO public.outreach_agent_decisions(id,organization_id,campaign_id,thread_id,source_reply_id,control_revision,brief_revision,policy_revision,source_body_hash,classification,approved)
 VALUES('${ids.decision}','${ids.org}','${ids.campaign}','${ids.thread}','${ids.sourceReply}',1,1,1,repeat('a',64),'{"intent":"interested","confidence":0.95}','false');
INSERT INTO public.outreach_agent_decisions(id,organization_id,campaign_id,thread_id,source_reply_id,control_revision,brief_revision,policy_revision,source_body_hash,classification,approved)
 VALUES('${ids.otherDecision}','${ids.org}','${ids.campaign}','${ids.thread}','${ids.sourceReply}',2,1,1,repeat('b',64),'{"intent":"interested","confidence":0.95}','true');
INSERT INTO public.outreach_agent_policies(organization_id,campaign_id,policy) VALUES('${ids.org}','${ids.campaign}','{"enabled":true,"minConfidence":0.95,"startHour":0,"endHour":24,"allowedIntents":["interested"],"maxReplies":1}');
INSERT INTO public.outreach_conversation_controls(organization_id,thread_id,mode,updated_by) VALUES('${ids.org}','${ids.thread}','autonomous','${ids.owner}');
INSERT INTO public.winnr_ingested_messages(organization_id,connection_id,connection_version,provider_account_id,account_id,mailbox_id,message_id,from_email,to_email,subject,received_at,reply_id,body_status)
 VALUES('${ids.org}','${ids.account}',1,'fixture-account','${ids.account}','fixture-mailbox','<source@example.test>','lead@example.test','sender@example.test','Fixture',now(),'${ids.sourceReply}','ready');
UPDATE public.outreach_agent_decisions SET source_body_hash=encode(sha256(convert_to('Here is the original inbound body','UTF8')),'hex');
INSERT INTO public.outreach_operations_control(organization_id) VALUES('${ids.org}');`)
}

describe.skipIf(!url)('033 bounded downstream outreach on real PostgreSQL', () => {
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
      '033_outreach_downstream.sql',
    ]) {
      expect(() => runSql(url as string, readFileSync(`supabase/migrations/${file}`, 'utf8'))).not.toThrow()
    }
  })

  beforeEach(() => {
    reset()
  })

  it('saves a connection disabled by default and reads presence only', () => {
    saveConnection('ghl', 0, 'aes-ciphertext-synthetic', { locationId: 'loc_1' })
    const read = parsed('read', {})
    const connections = read.connections as Array<Record<string, unknown>>
    const ghl = connections.find((c) => c.provider === 'ghl')
    expect(ghl).toMatchObject({ provider: 'ghl', revision: 1, enabled: false, configured: true })
    expect(JSON.stringify(read)).not.toContain('aes-ciphertext-synthetic')
    expect(read.masterStop).toBe(false)
  })

  it('rejects a stale connection revision (CAS)', () => {
    saveConnection('ghl', 0, 'cipher', { locationId: 'loc_1' })
    const stale = call('saveConnection', { provider: 'ghl', expectedRevision: 0, ciphertext: 'cipher2', config: { locationId: 'loc_1' } })
    expect(stale.code).not.toBe(0)
    expect(stale.err).toContain('downstream:stale')
  })

  it('performs no effect while a provider is disabled', () => {
    saveConnection('ghl', 0, 'cipher', { locationId: 'loc_1' })
    const reserved = parsedEffect('reserveEffect', {
      provider: 'ghl',
      decisionId: ids.decision,
      effectKind: 'ghl_contact',
      logicalKey: `decision:${ids.decision}:ghl_contact`,
      payloadFingerprint: 'a'.repeat(64),
      connectionRevision: 1,
    })
    expect(reserved).toMatchObject({ allowed: false, reason: 'provider_disabled' })
    expect(ok('SELECT count(*) FROM public.outreach_downstream_effects')).toBe('0')
  })

  it('reserves an effect exactly once and holds an unknown outcome without retry', () => {
    saveConnection('ghl', 0, 'cipher', { locationId: 'loc_1' })
    parsed('setEnabled', { provider: 'ghl', expectedRevision: 1, enabled: true })
    const payload = {
      provider: 'ghl',
      decisionId: ids.decision,
      effectKind: 'ghl_contact',
      logicalKey: `decision:${ids.decision}:ghl_contact`,
      payloadFingerprint: 'c'.repeat(64),
      connectionRevision: 2,
    }
    const first = parsedEffect('reserveEffect', payload)
    expect(first).toMatchObject({ allowed: true, status: 'reserved' })
    const second = parsedEffect('reserveEffect', payload)
    expect(second).toMatchObject({ allowed: false, reason: 'effect_exists', status: 'reserved' })

    // The effect is claimed under an exclusive fence before any provider call.
    const claim = parsedEffect('claimEffect', {})
    expect(claim).toMatchObject({ effectId: first.effectId })
    // A concurrent worker gets nothing.
    expect(parsedEffect('claimEffect', {})).toMatchObject({ effectId: null })
    // A settlement without the fenced token is stale.
    const stale = parsedEffect('settleEffect', { effectId: first.effectId, dispatchToken: ids.otherOwner, status: 'unknown' })
    expect(stale).toMatchObject({ result: 'stale' })
    const grant=grantWrite('effect',first.effectId,{locationId:'loc_1',email:'lead@example.test',source:'coldforge-outreach',phone:'+14155550100'},{dispatchToken:claim.dispatchToken})
    const unknown = parsedEffect('settleEffect', { ...grant, effectId: first.effectId, dispatchToken: claim.dispatchToken, status: 'unknown', errorCode: 'timeout' })
    expect(unknown).toMatchObject({ result: 'settled' })
    expect(ok('SELECT status FROM public.outreach_downstream_effects')).toBe('unknown')
    // An unknown effect is never automatically eligible again.
    expect(parsedEffect('claimEffect', {})).toMatchObject({ effectId: null })
  })

  it('creates an opportunity only after an explicit qualification record', () => {
    saveConnection('ghl', 0, 'cipher', { locationId: 'loc_1', pipelineId: 'pipe_1' })
    parsed('setEnabled', { provider: 'ghl', expectedRevision: 1, enabled: true })
    const blocked = parsedEffect('reserveEffect', {
      provider: 'ghl',
      decisionId: ids.decision,
      effectKind: 'ghl_opportunity',
      logicalKey: `decision:${ids.decision}:ghl_opportunity`,
      payloadFingerprint: 'd'.repeat(64),
      connectionRevision: 2,
    })
    expect(blocked).toMatchObject({ allowed: false, reason: 'not_qualified' })

    parsed('qualify', {
      leadId: ids.lead,
      criteriaRevision: 1,
      criteria: { required: ['budget', 'authority'] },
      outcome: 'qualified',
      evidence: 'Explicit owner-reviewed qualification note',
      attributedSource: 'operator.review',
    })
    parsedEffect('recordCrmLink',{leadId:ids.lead,externalContactId:'qualified-contact',locationId:'loc_1'})
    const allowed = parsedEffect('reserveEffect', {
      provider: 'ghl',
      decisionId: ids.decision,
      effectKind: 'ghl_opportunity',
      logicalKey: `decision:${ids.decision}:ghl_opportunity`,
      payloadFingerprint: 'd'.repeat(64),
      connectionRevision: 2,
    })
    expect(allowed).toMatchObject({ allowed: true })
  })

  it('forwards to CloseBot only for an approved canonical decision', () => {
    saveConnection('closebot', 0, 'cipher', { sourceId: 'source_1' })
    parsed('setEnabled', { provider: 'closebot', expectedRevision: 1, enabled: true })
    const unapproved = parsedEffect('reserveEffect', {
      provider: 'closebot',
      decisionId: ids.decision,
      effectKind: 'closebot_forward',
      logicalKey: `decision:${ids.decision}:closebot_forward`,
      payloadFingerprint: 'e'.repeat(64),
      connectionRevision: 2,
    })
    expect(unapproved).toMatchObject({ allowed: false, reason: 'decision_not_approved' })
    const approved = parsedEffect('reserveEffect', {
      provider: 'closebot',
      decisionId: ids.otherDecision,
      effectKind: 'closebot_forward',
      logicalKey: `decision:${ids.otherDecision}:closebot_forward`,
      payloadFingerprint: 'f'.repeat(64),
      connectionRevision: 2,
    })
    expect(approved).toMatchObject({ allowed: true })
  })

  it('records callback eligibility only for an owner/admin and gates the callback on it', () => {
    const forbidden = call('recordEligibility', { leadId: ids.lead, phoneE164: '+14155550100', timezone: 'UTC', windowStartHour: 0, windowEndHour: 24, expiresAt: new Date(Date.now() + 86400000).toISOString(), maxCalls: 2, consentBasis: 'Owner-verified prior consent', evidence: 'CRM note 2026-10-05' }, ids.member)
    expect(forbidden.code).not.toBe(0)
    expect(forbidden.err).toContain('downstream:forbidden')

    const eligibilityId = parsed('recordEligibility', {
      leadId: ids.lead,
      phoneE164: '+14155550100',
      timezone: 'UTC',
      windowStartHour: 0,
      windowEndHour: 24,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      maxCalls: 2,
      consentBasis: 'Owner-verified prior consent',
      evidence: 'CRM note 2026-10-05',
    }).eligibilityId as string

    // Retell disabled: no callback reservation.
    const disabled = parsedEffect('reserveCallback', { eligibilityId, connectionRevision: 1 })
    expect(disabled).toMatchObject({ allowed: false, reason: 'provider_disabled' })

    saveConnection('retell', 0, 'cipher', { fromNumber: '+14155550999' })
    parsed('setEnabled', { provider: 'retell', expectedRevision: 1, enabled: true })
    const reserved = parsedEffect('reserveCallback', { eligibilityId, connectionRevision: 2 })
    expect(reserved).toMatchObject({ allowed: true, phoneE164: '+14155550100' })
    expect(ok(`SELECT calls_started FROM public.outreach_callback_eligibility WHERE id='${eligibilityId}'`)).toBe('1')
    const again = parsedEffect('reserveCallback', { eligibilityId, connectionRevision: 2 })
    expect(again).toMatchObject({ allowed: false, reason: 'callback_exists' })
  })

  it('blocks a callback when the lead phone no longer matches the recorded eligibility', () => {
    parsed('recordEligibility', {
      leadId: ids.lead,
      phoneE164: '+14155550100',
      timezone: 'UTC',
      windowStartHour: 0,
      windowEndHour: 24,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      maxCalls: 1,
      consentBasis: 'Owner-verified prior consent',
      evidence: 'CRM note',
    })
    ok(`UPDATE public.leads SET phone='+14155550777' WHERE id='${ids.lead}'`)
    saveConnection('retell', 0, 'cipher', { fromNumber: '+14155550999' })
    parsed('setEnabled', { provider: 'retell', expectedRevision: 1, enabled: true })
    const eligibilityId = ok('SELECT id FROM public.outreach_callback_eligibility LIMIT 1')
    const result = parsedEffect('reserveCallback', { eligibilityId, connectionRevision: 2 })
    expect(result).toMatchObject({ allowed: false, reason: 'phone_changed' })
  })

  it('checks the current master stop at the final callback grant', () => {
    parsed('recordEligibility', {
      leadId: ids.lead,
      phoneE164: '+14155550100',
      timezone: 'UTC',
      windowStartHour: 0,
      windowEndHour: 24,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      maxCalls: 1,
      consentBasis: 'Owner-verified prior consent',
      evidence: 'CRM note',
    })
    saveConnection('retell', 0, 'cipher', { fromNumber: '+14155550999' })
    parsed('setEnabled', { provider: 'retell', expectedRevision: 1, enabled: true })
    const eligibilityId = ok('SELECT id FROM public.outreach_callback_eligibility LIMIT 1')
    ok(`UPDATE public.outreach_operations_control SET master_stop=true`);
    const result = parsedEffect('reserveCallback', { eligibilityId, connectionRevision: 2 })
    expect(result).toMatchObject({ allowed: false, reason: 'master_stop' })
    expect(ok('SELECT count(*) FROM public.outreach_callbacks')).toBe('0')
  })

  it('deduplicates authenticated webhook events and bridges inbound records', () => {
    const payload = {
      provider: 'retell',
      eventKey: 'call_started:call_1',
      providerCallId: 'call_1',
      payloadFingerprint: 'a'.repeat(64),
      status: 'initiated',
    }
    expect(parsedEffect('recordWebhookEvent', payload)).toMatchObject({ result: 'recorded' })
    expect(parsedEffect('recordWebhookEvent', payload)).toMatchObject({ result: 'duplicate' })
    expect(ok('SELECT count(*) FROM public.outreach_downstream_webhook_events')).toBe('1')
  })

  it('refuses to bridge an inbound record for a lead in another organization', () => {
    const rejected = effect('recordInboundBridge', {
      leadId: ids.otherLead,
      sourceId: 'source_1',
      payloadFingerprint: 'b'.repeat(64),
      proposal: {},
    })
    expect(rejected.code).not.toBe(0)
    expect(rejected.err).toContain('downstream:invalid')
    expect(ok('SELECT count(*) FROM public.outreach_closebot_bridge')).toBe('0')
  })

  it('selects a current owner for the configured organization', () => {
    saveConnection('ghl', 0, 'cipher', { locationId: 'loc_1' })
    parsed('setEnabled', { provider: 'ghl', expectedRevision: 1, enabled: true })
    const next = runSql(url as string, 'SELECT public.outreach_downstream_next_org()')
    expect(JSON.parse(next)).toMatchObject({ organizationId: ids.org, actorId: ids.owner })
  })

  it('reserves an appointment once, binds the server-side contact and holds an unknown write', () => {
    saveConnection('ghl', 0, 'cipher', { locationId: 'loc_1', pipelineId: 'pipe_1' })
    parsed('setEnabled', { provider: 'ghl', expectedRevision: 1, enabled: true })
    const startsAt = new Date(Date.now() + 3600000).toISOString()
    const base = { leadId: ids.lead, calendarId: 'cal_1', locationId: 'loc_1', startsAt, timezone: 'UTC', logicalKey: `appointment:${ids.lead}:cal_1:${startsAt}`, connectionRevision: 2 }

    // No CRM contact yet: a booking can never invent a contact binding.
    const noContact = parsedEffect('reserveAppointment', base)
    expect(noContact).toMatchObject({ allowed: false, reason: 'contact_not_synced' })

    parsedEffect('recordCrmLink', { leadId: ids.lead, externalContactId: 'ghl_contact_1', locationId: 'loc_1' })
    const first = parsedEffect('reserveAppointment', base)
    expect(first).toMatchObject({ allowed: true, status: 'reserved', crmContactId: 'ghl_contact_1' })
    // A duplicate logical key is a hold, never a second provider write.
    const second = parsedEffect('reserveAppointment', base)
    expect(second).toMatchObject({ allowed: false, reason: 'appointment_in_progress' })

    const grant=grantWrite('appointment_create',first.appointmentId,bookingPayload(startsAt))
    const held = parsedEffect('settleAppointment', { ...grant, appointmentId: first.appointmentId, status: 'unknown', errorCode: 'timeout' })
    expect(held).toMatchObject({ result: 'settled' })
    expect(ok('SELECT status FROM public.outreach_appointments')).toBe('unknown')
    // An unknown hold is not re-selected as reserved.
    const reserved = parsedEffect('claimEffect', {})
    expect(reserved.effectId).toBeNull()
  })

  it('settles a confirmed appointment and matches a GHL webhook only on location + provider id', () => {
    saveConnection('ghl', 0, 'cipher', { locationId: 'loc_1', pipelineId: 'pipe_1' })
    parsed('setEnabled', { provider: 'ghl', expectedRevision: 1, enabled: true })
    parsedEffect('recordCrmLink', { leadId: ids.lead, externalContactId: 'ghl_contact_1', locationId: 'loc_1' })
    const startsAt = new Date(Date.now() + 7200000).toISOString()
    const reserved = parsedEffect('reserveAppointment', {
      leadId: ids.lead, calendarId: 'cal_1', locationId: 'loc_1', startsAt, endsAt: new Date(Date.parse(startsAt) + 1800000).toISOString(),
      timezone: 'UTC', logicalKey: `appointment:${ids.lead}:cal_1:${startsAt}`, connectionRevision: 2,
    })
    const grant=grantWrite('appointment_create',reserved.appointmentId,{...bookingPayload(startsAt),endAt:new Date(Date.parse(startsAt)+1800000).toISOString()})
    parsedEffect('settleAppointment', { ...grant, appointmentId: reserved.appointmentId, status: 'scheduled', providerAppointmentId: 'ghl_appt_1', startsAt, receipt: { appointmentId: 'ghl_appt_1' } })

    const unmatched = parsedEffect('recordWebhookEvent', { provider: 'ghl', eventKey: 'AppointmentUpdate:ghl_appt_1', providerAppointmentId: 'ghl_appt_1', locationId: 'loc_other', status: 'cancelled', payloadFingerprint: '1'.repeat(64) })
    expect(unmatched).toMatchObject({ result: 'unmatched' })
    expect(ok('SELECT status FROM public.outreach_appointments')).toBe('scheduled')

    const matched = parsedEffect('recordWebhookEvent', { provider: 'ghl', eventKey: 'AppointmentDelete:ghl_appt_1', providerAppointmentId: 'ghl_appt_1', locationId: 'loc_1', status: 'cancelled', payloadFingerprint: '2'.repeat(64) })
    expect(matched).toMatchObject({ result: 'matched' })
    expect(ok('SELECT status FROM public.outreach_appointments')).toBe('cancelled')
  })

  it('lets only an owner/admin review a CloseBot proposal and never sends a reply', () => {
    parsedEffect('recordInboundBridge', { leadId: ids.lead, threadId:ids.thread, sourceId: 'source_1', payloadFingerprint: 'c'.repeat(64), proposal: { body: 'Interested in a call' } })
    const bridgeId = ok('SELECT id FROM public.outreach_closebot_bridge LIMIT 1')
    const forbidden = call('reviewBridge', { bridgeId, decision: 'taken_over' }, ids.member)
    expect(forbidden.code).not.toBe(0)
    expect(forbidden.err).toContain('downstream:forbidden')
    const reviewed = parsed('reviewBridge', { bridgeId, decision: 'taken_over', note: 'Operator will reply from the shared inbox' })
    expect(reviewed).toMatchObject({ saved: true, decision: 'taken_over' })
    expect(ok('SELECT status FROM public.outreach_closebot_bridge')).toBe('taken_over')
    // Reviewing a proposal never creates an email/effect by itself.
    expect(ok('SELECT count(*) FROM public.outreach_downstream_effects')).toBe('0')
  })

  it('holds the canonical operation across a second decision and rejects a stale revision at the grant', () => {
    saveConnection('ghl', 0, 'cipher', { locationId: 'loc_1' })
    parsed('setEnabled', { provider: 'ghl', expectedRevision: 1, enabled: true })
    const base = { provider: 'ghl', effectKind: 'ghl_contact', payloadFingerprint: '9'.repeat(64), connectionRevision: 2 }
    const first = parsedEffect('reserveEffect', { ...base, decisionId: ids.decision, logicalKey: 'arbitrary-browser-key' })
    expect(first).toMatchObject({ allowed: true })
    // A second decision about the same canonical source reply cannot reserve again.
    const second = parsedEffect('reserveEffect', { ...base, decisionId: ids.otherDecision, payloadFingerprint: '8'.repeat(64), logicalKey: 'another-arbitrary-key' })
    expect(second).toMatchObject({ allowed: false, reason: 'effect_exists' })
    expect(ok('SELECT count(*) FROM public.outreach_downstream_effects')).toBe('1')

    const claim = parsedEffect('claimEffect', {})
    expect(claim.effectId).toBe(first.effectId)
    // Configuration changed from revision 2 to 3 after reserve: the exact
    // version final authorization rejects the stale effect.
    parsed('saveConnection', { provider: 'ghl', expectedRevision: 2, ciphertext: 'cipher', config: { locationId: 'loc_2' } })
    const context = parsedEffect('effectContext', { effectId: claim.effectId, dispatchToken: claim.dispatchToken })
    expect(context).toMatchObject({ connectionStale: true, connectionRevision: 3 })
  })

  it('enriches a completed Retell call with terminal analysis and rejects conflicting replays', () => {
    parsed('recordEligibility', {
      leadId: ids.lead, phoneE164: '+14155550100', timezone: 'UTC', windowStartHour: 0, windowEndHour: 24,
      expiresAt: new Date(Date.now() + 86400000).toISOString(), maxCalls: 2, consentBasis: 'Owner-verified prior consent', evidence: 'CRM note',
    })
    saveConnection('retell', 0, 'cipher', { fromNumber: '+14155550999' })
    parsed('setEnabled', { provider: 'retell', expectedRevision: 1, enabled: true })
    const eligibilityId = ok('SELECT id FROM public.outreach_callback_eligibility LIMIT 1')
    const reserved = parsedEffect('reserveCallback', { eligibilityId, connectionRevision: 2 })
    const grant=grantWrite('callback',reserved.callbackId,callbackPayload(reserved.callbackId))
    parsedEffect('settleCallback', { ...grant, callbackId: reserved.callbackId, status: 'initiated', providerCallId: 'review-call' })

    expect(parsedEffect('recordWebhookEvent', { provider: 'retell', eventKey: 'call_ended:review-call', providerCallId: 'review-call', payloadFingerprint: '1'.repeat(64), status: 'completed' })).toMatchObject({ result: 'recorded' })
    // Terminal analysis enriches the completed call instead of being discarded.
    expect(parsedEffect('recordWebhookEvent', { provider: 'retell', eventKey: 'call_analyzed:review-call', providerCallId: 'review-call', payloadFingerprint: '2'.repeat(64), status: 'completed', summary: { call_successful: true } })).toMatchObject({ result: 'recorded' })
    expect(ok(`SELECT status||':'||coalesce(summary->>'call_successful','NULL') FROM public.outreach_callbacks`)).toBe('completed:true')

    const conflict = effect('recordWebhookEvent', { provider: 'retell', eventKey: 'call_ended:review-call', providerCallId: 'review-call', payloadFingerprint: '3'.repeat(64), status: 'completed' })
    expect(conflict.code).not.toBe(0)
    expect(conflict.err).toContain('downstream:conflict')
  })

  it('deduplicates a CloseBot qualification by source event and rejects a conflicting body', () => {
    const base = {
      leadId: ids.lead, criteriaRevision: 1, criteria: { intent: 'ready' }, outcome: 'qualified',
      evidence: 'CloseBot transcript', attributedSource: 'closebot.callback',
      sourceEventKey: 'cb-message-1', payloadFingerprint: '4'.repeat(64),
    }
    const first = parsedEffect('recordProviderQualification', base)
    expect(first).toMatchObject({ result: 'recorded' })
    const replay = parsedEffect('recordProviderQualification', base)
    expect(replay).toMatchObject({ result: 'duplicate' })
    expect(replay.qualificationId).toBe(first.qualificationId)
    expect(ok('SELECT count(*) FROM public.outreach_qualifications')).toBe('1')

    const conflict = effect('recordProviderQualification', { ...base, payloadFingerprint: '5'.repeat(64) })
    expect(conflict.code).not.toBe(0)
    expect(conflict.err).toContain('downstream:conflict')
  })

  it('skips an ownerless eligible organization instead of starving others', () => {
    saveConnection('ghl', 0, 'cipher', { locationId: 'loc_1' })
    parsed('setEnabled', { provider: 'ghl', expectedRevision: 1, enabled: true })
    parsed('saveConnection', { provider: 'ghl', expectedRevision: 0, ciphertext: 'cipher', config: { locationId: 'loc_2' } }, ids.otherOwner, ids.otherOrg)
    parsed('setEnabled', { provider: 'ghl', expectedRevision: 1, enabled: true }, ids.otherOwner, ids.otherOrg)
    // The oldest eligible organization loses its owner/admin.
    ok(`UPDATE public.users SET role='member' WHERE organization_id='${ids.org}'`)
    ok('DELETE FROM public.outreach_downstream_scheduler')
    const next = runSql(url as string, 'SELECT public.outreach_downstream_next_org()')
    expect(JSON.parse(next)).toMatchObject({ organizationId: ids.otherOrg, actorId: ids.otherOwner })
  })
  function rpcRepository():DownstreamRepository {
   return {
    effect:async(org,action,payload)=>parsedEffect(action,payload,org),
    reserveEffect:async(org,payload)=>parsedEffect('reserveEffect',payload,org),
    effectContext:async(org,effectId,dispatchToken)=>effectContextSchema.parse(parsedEffect('effectContext',{effectId,dispatchToken},org)),
    settleEffect:async(org,payload)=>{if(parsedEffect('settleEffect',payload,org).result!=='settled')throw Error('Stale fixture receipt')},
    recordCrmLink:async(org,payload)=>parsedEffect('recordCrmLink',payload,org),
    connectionSecret:async(org,provider)=>connectionSecretSchema.parse(parsedEffect('connectionSecret',{provider},org)),
    reserveCallback:async(org,payload)=>parsedEffect('reserveCallback',payload,org),
    settleCallback:async(org,payload)=>{if(parsedEffect('settleCallback',payload,org).result!=='settled')throw Error('Stale callback receipt')},
    settleAppointment:async(org,payload)=>{if(parsedEffect('settleAppointment',payload,org).result!=='settled')throw Error('Stale appointment receipt')},
    read:async actor=>downstreamReadSchema.parse(parsed('read',{},actor.userId,actor.organizationId)),
   } as DownstreamRepository
  }
  function runtimePorts(counter:{calls:number}){
   const fetch:typeof globalThis.fetch=async(_url,init)=>{expect(init?.method).toBe('POST');expect(init?.signal?.aborted).toBe(false);counter.calls+=1;return new Response(JSON.stringify({contact:{id:'runtime-contact'},deleted:true}),{status:200})}
   return {ghl:createGhlPort({fetch}),retell:createRetellPort({fetch}),closebot:createCloseBotPort({fetch})}
  }
  function runtimeCipher(){process.env.ENCRYPTION_SECRET='synthetic-pg-runtime';process.env.ENCRYPTION_SALT='synthetic-pg-runtime-salt';return encrypt(JSON.stringify({apiKey:'synthetic-provider-key'}))}
  const contactWrite = {locationId:'loc_1',email:'lead@example.test',source:'coldforge-outreach',phone:'+14155550100'}
  function reserveContact(cipher='cipher'){saveConnection('ghl',0,cipher,{locationId:'loc_1'});parsed('setEnabled',{provider:'ghl',expectedRevision:1,enabled:true});const r=parsedEffect('reserveEffect',{provider:'ghl',decisionId:ids.decision,effectKind:'ghl_contact',payloadFingerprint:'a'.repeat(64),connectionRevision:2});const c=parsedEffect('claimEffect',{});return {r,c}}
  function reserveCall(){saveConnection('retell',0,'cipher',{fromNumber:'+14155550999'});parsed('setEnabled',{provider:'retell',expectedRevision:1,enabled:true});const e=parsed('recordEligibility',{leadId:ids.lead,phoneE164:'+14155550100',timezone:'UTC',windowStartHour:0,windowEndHour:24,expiresAt:new Date(Date.now()+86400000).toISOString(),maxCalls:2,consentBasis:'Explicit fixture consent',evidence:'Fixture record'});return {e,r:parsedEffect('reserveCallback',{eligibilityId:e.eligibilityId,connectionRevision:2})}}
  function confirmedAppointment(){saveConnection('ghl',0,'cipher',{locationId:'loc_1'});parsed('setEnabled',{provider:'ghl',expectedRevision:1,enabled:true});parsedEffect('recordCrmLink',{leadId:ids.lead,externalContactId:'ghl_contact_1',locationId:'loc_1'});const startsAt=new Date(Date.now()+7200000).toISOString();const r=parsedEffect('reserveAppointment',{leadId:ids.lead,calendarId:'cal_1',locationId:'loc_1',startsAt,timezone:'UTC',connectionRevision:2,logicalKey:'ignored-client-key'});const grant=grantWrite('appointment_create',r.appointmentId,bookingPayload(startsAt));parsedEffect('settleAppointment',{...grant,appointmentId:r.appointmentId,status:'scheduled',providerAppointmentId:'appointment_1',startsAt});return r.appointmentId}

  it.each(['body','human','owner','stop','provider','suppression'])('refuses an effect when %s changes after preparation',change=>{
   const {r,c}=reserveContact();const g=beginWrite('effect',r.effectId,contactWrite,{dispatchToken:c.dispatchToken});expect(g.allowed).toBe(true)
   if(change==='body')ok(`UPDATE public.replies SET body_text='Changed unapproved text' WHERE id='${ids.sourceReply}'`)
   if(change==='human')ok(`UPDATE public.outreach_conversation_controls SET mode='human',revision=revision+1 WHERE thread_id='${ids.thread}'`)
   if(change==='owner')ok(`UPDATE public.users SET role='member' WHERE id='${ids.owner}'`)
   if(change==='stop')ok(`UPDATE public.outreach_operations_control SET master_stop=true WHERE organization_id='${ids.org}'`)
   if(change==='provider')parsed('saveConnection',{provider:'ghl',expectedRevision:2,ciphertext:'replacement',config:{locationId:'other-location'}})
   if(change==='suppression')ok(`SELECT public.record_outreach_suppression('${ids.org}','lead@example.test','unsubscribe','fixture',NULL,NULL,NULL,'${ids.lead}')`)
   expect(parsedEffect('authorizeWrite',g).allowed).toBe(false)
   expect(ok('SELECT count(*) FROM public.outreach_downstream_writes WHERE authorized_at IS NOT NULL')).toBe('0')
  })
  it('rejects an effect payload whose actual immutable contact identity differs',()=>{
   const {r,c}=reserveContact();expect(beginWrite('effect',r.effectId,{...contactWrite,email:'different@example.test'},{dispatchToken:c.dispatchToken})).toMatchObject({allowed:false,reason:'content_changed'})
  })
  it('spends a final effect grant once across competing database workers and fences receipt content',async()=>{
   const {r,c}=reserveContact();const g=beginWrite('effect',r.effectId,contactWrite,{dispatchToken:c.dispatchToken});expect(g.allowed).toBe(true)
   const command=`SELECT public.outreach_downstream_effect('${ids.org}','authorizeWrite',${quote(g)})`
   const env={NODE_ENV:'test' as const,...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('PG')))}
   const invoke=()=>promisify(execFile)(process.env.PSQL?.trim()||'psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1','--dbname',url as string,'-c',command],{env,encoding:'utf8'})
   const grants=await Promise.all([invoke(),invoke()]);expect(grants.map(v=>(JSON.parse(v.stdout) as {allowed:boolean}).allowed).sort()).toEqual([false,true])
   expect(parsedEffect('settleEffect',{...g,fingerprint:'b'.repeat(64),effectId:r.effectId,dispatchToken:c.dispatchToken,status:'succeeded'}).result).toBe('stale')
   expect(parsedEffect('settleEffect',{...g,effectId:r.effectId,dispatchToken:c.dispatchToken,status:'unknown'}).result).toBe('settled')
   expect(beginWrite('effect',r.effectId,contactWrite,{dispatchToken:c.dispatchToken}).allowed).toBe(false)
  })
  it.each(['revoked','phone','window','owner','provider','stop'])('rechecks callback %s at the final handoff',change=>{
   const {e,r}=reserveCall();const g=beginWrite('callback',r.callbackId,callbackPayload(r.callbackId));expect(g.allowed).toBe(true)
   if(change==='revoked')parsed('revokeEligibility',{eligibilityId:e.eligibilityId,expectedRevision:1})
   if(change==='phone')ok(`UPDATE public.leads SET phone='+14155550199' WHERE id='${ids.lead}'`)
   if(change==='window')ok(`UPDATE public.outreach_callback_eligibility SET expires_at=now()-interval '1 minute' WHERE id='${e.eligibilityId}'`)
   if(change==='owner')ok(`UPDATE public.users SET role='member' WHERE id='${ids.owner}'`)
   if(change==='provider')parsed('setEnabled',{provider:'retell',expectedRevision:2,enabled:false})
   if(change==='stop')ok(`UPDATE public.outreach_operations_control SET master_stop=true WHERE organization_id='${ids.org}'`)
   expect(parsedEffect('authorizeWrite',g).allowed).toBe(false)
  })
  it('holds callback receipt loss visibly after expiry and new consent cannot bypass the unresolved call',()=>{
   const {r}=reserveCall();const g=grantWrite('callback',r.callbackId,callbackPayload(r.callbackId));ok(`UPDATE public.outreach_downstream_writes SET authorized_at=now()-interval '1 minute' WHERE id='${g.writeId}'`)
   parsed('read',{});expect(ok('SELECT status FROM public.outreach_callbacks')).toBe('unknown')
   const e=parsed('recordEligibility',{leadId:ids.lead,phoneE164:'+14155550100',timezone:'UTC',windowStartHour:0,windowEndHour:24,expiresAt:new Date(Date.now()+86400000).toISOString(),maxCalls:2,consentBasis:'Renewed fixture consent',evidence:'New fixture record'})
   expect(parsedEffect('reserveCallback',{eligibilityId:e.eligibilityId,connectionRevision:2,logicalKey:'new-browser-key'}).reason).toBe('callback_exists')
  })
  it('serializes cancel/reschedule intents and holds the appointment after ambiguous mutation',()=>{
   const id=confirmedAppointment();const g=beginWrite('appointment_cancel',id,{appointmentId:'appointment_1'});expect(g.allowed).toBe(true)
   const startAt=new Date(Date.now()+10800000).toISOString();expect(beginWrite('appointment_reschedule',id,{locationId:'loc_1',appointmentId:'appointment_1',startAt,timezone:'UTC'}).reason).toBe('write_held')
   expect(parsedEffect('authorizeWrite',g).allowed).toBe(true)
   expect(parsedEffect('authorizeWrite',g).allowed).toBe(false)
   expect(parsedEffect('settleAppointment',{...g,appointmentId:id,status:'rescheduled',startsAt:startAt}).result).toBe('stale')
   expect(parsedEffect('settleAppointment',{...g,appointmentId:id,status:'unknown'}).result).toBe('settled')
   expect(beginWrite('appointment_cancel',id,{appointmentId:'appointment_1'}).allowed).toBe(false)
  })
  it('replays an early authenticated terminal callback only after the fenced call receipt binds it',()=>{
   const {r}=reserveCall();const g=grantWrite('callback',r.callbackId,callbackPayload(r.callbackId))
   const event={provider:'retell',eventKey:'analysis:early-call',providerCallId:'early-call',payloadFingerprint:'b'.repeat(64),status:'completed',summary:{call_successful:true}}
   parsedEffect('recordWebhookEvent',event);expect(ok('SELECT status FROM public.outreach_callbacks')).toBe('reserved')
   parsedEffect('settleCallback',{...g,callbackId:r.callbackId,status:'initiated',providerCallId:'early-call'})
   expect(ok("SELECT status||':'||(summary->>'call_successful') FROM public.outreach_callbacks")).toBe('completed:true')
   expect(parsedEffect('recordWebhookEvent',event).result).toBe('duplicate')
  })
  it('replays an early GHL cancellation after create receipt without inventing a match',()=>{
   saveConnection('ghl',0,'cipher',{locationId:'loc_1'});parsed('setEnabled',{provider:'ghl',expectedRevision:1,enabled:true});parsedEffect('recordCrmLink',{leadId:ids.lead,externalContactId:'ghl_contact_1',locationId:'loc_1'});const startsAt=new Date(Date.now()+3600000).toISOString()
   const r=parsedEffect('reserveAppointment',{leadId:ids.lead,calendarId:'cal_1',locationId:'loc_1',startsAt,timezone:'UTC',logicalKey:'initial-key',connectionRevision:2});const g=grantWrite('appointment_create',r.appointmentId,bookingPayload(startsAt))
   parsedEffect('recordWebhookEvent',{provider:'ghl',eventKey:'cancel:early',providerAppointmentId:'early-appointment',locationId:'loc_1',payloadFingerprint:'c'.repeat(64),status:'cancelled'})
   parsedEffect('settleAppointment',{...g,appointmentId:r.appointmentId,status:'scheduled',providerAppointmentId:'early-appointment',startsAt})
   expect(ok('SELECT status FROM public.outreach_appointments')).toBe('cancelled')
  })
  it('CloseBot take over updates canonical human control and invalidates pending automation',()=>{
   parsedEffect('recordInboundBridge',{leadId:ids.lead,threadId:ids.thread,sourceId:'source_1',payloadFingerprint:'d'.repeat(64),proposal:{body:'Operator review'}})
   const bridgeId=ok('SELECT id FROM public.outreach_closebot_bridge LIMIT 1');parsed('reviewBridge',{bridgeId,decision:'taken_over'})
   expect(ok(`SELECT mode||':'||revision FROM public.outreach_conversation_controls WHERE thread_id='${ids.thread}'`)).toBe('human:2')
   expect(ok('SELECT count(*) FROM public.sent_emails')).toBe('0')
  })

  function qualifyCurrent(outcome='qualified',scope:Record<string,unknown>={}) { return parsed('qualify',{leadId:ids.lead,campaignId:ids.campaign,threadId:ids.thread,criteriaRevision:1,criteria:{budget:true},outcome,evidence:'Operator verified current criteria',attributedSource:'operator',...scope}) }
  function approveFlowDecision() {
   ok(`INSERT INTO public.outreach_offer_briefs(organization_id,campaign_id,brief) VALUES('${ids.org}','${ids.campaign}','{"faqs":[{"id":"ready","intent":"interested","answer":"Here are the details."}],"exclusions":[]}');
    UPDATE public.outreach_agent_decisions SET approved=true,template_id='ready',fingerprint=repeat('f',64),prepared='{"message":{"text":"Here are the details.\\n\\nApproved footer"}}' WHERE id='${ids.decision}';`)
  }
  it('executes contact then qualified opportunity and approved CloseBot once without a preexisting CRM link',async()=>{
   const cipher=runtimeCipher();saveConnection('ghl',0,cipher,{locationId:'loc_1',pipelineId:'pipe_1'});parsed('setEnabled',{provider:'ghl',expectedRevision:1,enabled:true});saveConnection('closebot',0,cipher,{sourceId:'source_1'});parsed('setEnabled',{provider:'closebot',expectedRevision:1,enabled:true});approveFlowDecision();qualifyCurrent()
   const calls:string[]=[];const ports=runtimePorts({calls:0});ports.ghl.upsertContact=async()=>{calls.push('contact');return {contactId:'flow-contact',created:true}};ports.ghl.upsertOpportunity=async(_key,input)=>{expect(input.contactId).toBe('flow-contact');calls.push('opportunity');return {opportunityId:'flow-opportunity',created:true}};ports.closebot.sendEvent=async()=>{calls.push('closebot');return {accepted:true,receipt:{accepted:true}}}
   const repository=rpcRepository(),record=repository.recordCrmLink;const linkDeadlines:number[]=[];repository.recordCrmLink=async(org,payload,deadline)=>{expect(deadline).toBeTypeOf('number');expect(deadline).toBeGreaterThan(Date.now());if(typeof deadline!=='number')throw Error('Missing remaining deadline');linkDeadlines.push(deadline);return record(org,payload,deadline)}
   const deps={repository,ports} as DownstreamWorkerDeps
   for(let tick=0;tick<6;tick++){
    await reserveDecisionEffects(ids.org,ids.decision,ids.sourceReply,deps,Date.now()+20000)
    const claimed=parsedEffect('claimEffect',{});if(claimed.effectId)await executeReservedEffect(ids.org,String(claimed.effectId),String(claimed.dispatchToken),deps,Date.now()+20000)
   }
   expect(linkDeadlines).toHaveLength(2);expect(calls.sort()).toEqual(['closebot','contact','opportunity']);expect(ok("SELECT count(*) FROM public.outreach_downstream_effects WHERE status='succeeded'")).toBe('3')
  })
  it('rejects historical qualified evidence when the latest applicable qualification is disqualified',()=>{
   saveConnection('ghl',0,'cipher',{locationId:'loc_1',pipelineId:'pipe_1'});parsed('setEnabled',{provider:'ghl',expectedRevision:1,enabled:true});parsedEffect('recordCrmLink',{leadId:ids.lead,externalContactId:'flow-contact',locationId:'loc_1'});qualifyCurrent();qualifyCurrent('disqualified')
   expect(parsedEffect('reserveEffect',{provider:'ghl',decisionId:ids.decision,effectKind:'ghl_opportunity',payloadFingerprint:'a'.repeat(64),connectionRevision:2})).toMatchObject({allowed:false,reason:'not_qualified'})
  })

  it.each(['reserved','prepared'])('invalidates an opportunity after %s when the operator requalifies it',stage=>{
   saveConnection('ghl',0,'cipher',{locationId:'loc_1',pipelineId:'pipe_1'});parsed('setEnabled',{provider:'ghl',expectedRevision:1,enabled:true});parsedEffect('recordCrmLink',{leadId:ids.lead,externalContactId:'flow-contact',locationId:'loc_1'});qualifyCurrent()
   const r=parsedEffect('reserveEffect',{provider:'ghl',decisionId:ids.decision,effectKind:'ghl_opportunity',payloadFingerprint:'a'.repeat(64),connectionRevision:2});const c=parsedEffect('claimEffect',{});const payload={locationId:'loc_1',pipelineId:'pipe_1',contactId:'flow-contact',name:'lead@example.test',status:'open'}
   const g=stage==='prepared'?beginWrite('effect',r.effectId,payload,{dispatchToken:c.dispatchToken}):null
   if(g)expect(g.allowed).toBe(true)
   qualifyCurrent('disqualified',{criteriaRevision:2})
   expect(g?parsedEffect('authorizeWrite',g).allowed:beginWrite('effect',r.effectId,payload,{dispatchToken:c.dispatchToken}).allowed).toBe(false)
   expect(ok("SELECT count(*) FROM public.outreach_downstream_writes WHERE state='authorized'")).toBe('0')
  })
  it('uses only qualification applicable to the canonical campaign and thread',()=>{
   saveConnection('ghl',0,'cipher',{locationId:'loc_1',pipelineId:'pipe_1'});parsed('setEnabled',{provider:'ghl',expectedRevision:1,enabled:true});parsedEffect('recordCrmLink',{leadId:ids.lead,externalContactId:'flow-contact',locationId:'loc_1'});qualifyCurrent()
   const otherThread='99999999-9999-4999-8999-999999999992';ok(`INSERT INTO public.threads(id,organization_id,mailbox_id,participant_email,subject) VALUES('${otherThread}','${ids.org}','${ids.account}','lead@example.test','Other inquiry')`);qualifyCurrent('disqualified',{threadId:otherThread})
   expect(parsedEffect('reserveEffect',{provider:'ghl',decisionId:ids.decision,effectKind:'ghl_opportunity',payloadFingerprint:'a'.repeat(64),connectionRevision:2}).allowed).toBe(true)
  })
  it('cannot requalify or change decision identity to bypass an unknown opportunity effect',()=>{
   saveConnection('ghl',0,'cipher',{locationId:'loc_1',pipelineId:'pipe_1'});parsed('setEnabled',{provider:'ghl',expectedRevision:1,enabled:true});parsedEffect('recordCrmLink',{leadId:ids.lead,externalContactId:'flow-contact',locationId:'loc_1'});qualifyCurrent()
   const p={provider:'ghl',decisionId:ids.decision,effectKind:'ghl_opportunity',payloadFingerprint:'a'.repeat(64),connectionRevision:2};const r=parsedEffect('reserveEffect',p);const c=parsedEffect('claimEffect',{});const g=grantWrite('effect',r.effectId,{locationId:'loc_1',pipelineId:'pipe_1',contactId:'flow-contact',name:'lead@example.test',status:'open'},{dispatchToken:c.dispatchToken})
   parsedEffect('settleEffect',{...g,effectId:r.effectId,dispatchToken:c.dispatchToken,status:'unknown'});qualifyCurrent('disqualified');qualifyCurrent('qualified',{criteriaRevision:2})
   expect(parsedEffect('reserveEffect',{...p,decisionId:ids.otherDecision})).toMatchObject({allowed:false,reason:'effect_exists',status:'unknown'})
  })
  it('reports unknown instead of rescheduled when a canonical cancellation wins before receipt settlement',async()=>{
   const appointmentId=confirmedAppointment();ok(`UPDATE public.outreach_provider_connections SET credential_ciphertext='${runtimeCipher()}' WHERE provider='ghl'`)
   const repository=rpcRepository(),ports=runtimePorts({calls:0});const startAt=new Date(Date.now()+10800000).toISOString();let calls=0
   ports.ghl.listCalendars=async()=>[{id:'cal_1',name:'Fixture',locationId:'loc_1',slotDurationMinutes:30,durationOptions:[]}];ports.ghl.getCalendar=async()=>({id:'cal_1',name:'Fixture',locationId:'loc_1',slotDurationMinutes:30,durationOptions:[]});ports.ghl.freeSlots=async()=>[{startAt,endAt:null}]
   ports.ghl.rescheduleAppointment=async()=>{calls++;parsedEffect('recordWebhookEvent',{provider:'ghl',eventKey:'cancel-between-response-and-receipt',providerAppointmentId:'appointment_1',locationId:'loc_1',status:'cancelled',payloadFingerprint:'2'.repeat(64)});return {appointmentId:'appointment_1',receipt:{}}}
   const result=await rescheduleAppointment({userId:ids.owner,organizationId:ids.org,role:'owner'},{appointmentId:String(appointmentId),startAt,timezone:'UTC'},{repository,ports},Date.now()+20000)
   expect(calls).toBe(1);expect(result).toMatchObject({allowed:false,status:'unknown'});expect(ok('SELECT status FROM public.outreach_appointments')).toBe('cancelled')
  })

  it('runs actual effect orchestration through real RPC grants once under concurrent workers',async()=>{
   const {r,c}=reserveContact(runtimeCipher());const counter={calls:0},repository=rpcRepository();const deps={repository,ports:runtimePorts(counter)} as DownstreamWorkerDeps
   await Promise.all([executeReservedEffect(ids.org,String(r.effectId),String(c.dispatchToken),deps,Date.now()+20000),executeReservedEffect(ids.org,String(r.effectId),String(c.dispatchToken),deps,Date.now()+20000)])
   expect(counter.calls).toBe(1);expect(ok('SELECT status FROM public.outreach_downstream_effects')).toBe('succeeded');expect(ok("SELECT state FROM public.outreach_downstream_writes")).toBe('succeeded')
  })
  it('does not re-execute actual provider handoff after receipt storage failure',async()=>{
   const {r,c}=reserveContact(runtimeCipher());const counter={calls:0},repository=rpcRepository();repository.settleEffect=async()=>{throw Error('Synthetic lost DB receipt')};const deps={repository,ports:runtimePorts(counter)} as DownstreamWorkerDeps
   await executeReservedEffect(ids.org,String(r.effectId),String(c.dispatchToken),deps,Date.now()+20000)
   await executeReservedEffect(ids.org,String(r.effectId),String(c.dispatchToken),deps,Date.now()+20000)
   expect(counter.calls).toBe(1);ok("UPDATE public.outreach_downstream_writes SET authorized_at=now()-interval '1 minute'");parsed('read',{});expect(ok('SELECT status FROM public.outreach_downstream_effects')).toBe('unknown')
   expect(parsedEffect('claimEffect',{}).effectId).toBeNull()
  })
  it('actual callback orchestration refuses consent revoked after its real reservation',async()=>{
   const {e}=reserveCall();ok('DELETE FROM public.outreach_callbacks');ok(`UPDATE public.outreach_provider_connections SET credential_ciphertext='${runtimeCipher()}' WHERE provider='retell'`)
   const repository=rpcRepository(),reserve=repository.reserveCallback;repository.reserveCallback=async(org,payload,deadline)=>{const r=await reserve(org,payload,deadline);parsed('revokeEligibility',{eligibilityId:e.eligibilityId,expectedRevision:1});return r}
   const counter={calls:0};const result=await initiateRequestedCallback({userId:ids.owner,organizationId:ids.org,role:'owner'},String(e.eligibilityId),{repository,ports:runtimePorts(counter)} as DownstreamWorkerDeps)
   expect(result.allowed).toBe(false);expect(counter.calls).toBe(0)
  })
  it('actual concurrent cancel calls spend only one appointment mutation grant',async()=>{
   const id=confirmedAppointment();ok(`UPDATE public.outreach_provider_connections SET credential_ciphertext='${runtimeCipher()}' WHERE provider='ghl'`)
   const counter={calls:0},repository=rpcRepository();const ports=runtimePorts(counter);ports.ghl.cancelAppointment=async(_key,appointmentId,signal)=>{expect(appointmentId).toBe('appointment_1');expect(signal.aborted).toBe(false);counter.calls+=1;await Promise.resolve();return {cancelled:true,receipt:{deleted:true}}}
   const actor={userId:ids.owner,organizationId:ids.org,role:'owner' as const};const results=await Promise.all([cancelAppointment(actor,{appointmentId:String(id)},{repository,ports},Date.now()+20000),cancelAppointment(actor,{appointmentId:String(id)},{repository,ports},Date.now()+20000)])
   expect(counter.calls).toBe(1);expect(results.filter(result=>result.allowed)).toHaveLength(1);expect(ok('SELECT status FROM public.outreach_appointments')).toBe('cancelled')
  })

  it('records bridge and qualification atomically and rolls both back on conflicting source identity',()=>{
   const q={leadId:ids.lead,threadId:ids.thread,criteriaRevision:1,criteria:{budget:true},outcome:'qualified',evidence:'Explicit provider qualification',attributedSource:'closebot.callback',sourceEventKey:'canonical-provider-event',payloadFingerprint:'a'.repeat(64)}
   const base={leadId:ids.lead,threadId:ids.thread,sourceId:'fixture-source',payloadFingerprint:'a'.repeat(64),proposal:{body:'Review this'},qualification:q}
   const first=parsedEffect('recordQualifiedBridge',base);const second=parsedEffect('recordQualifiedBridge',base);expect(first.qualificationId).toBe(second.qualificationId)
   const conflict=effect('recordQualifiedBridge',{...base,payloadFingerprint:'b'.repeat(64),qualification:{...q,payloadFingerprint:'b'.repeat(64)}});expect(conflict.code).not.toBe(0)
   expect(ok('SELECT count(*) FROM public.outreach_closebot_bridge')).toBe('1');expect(ok('SELECT count(*) FROM public.outreach_qualifications')).toBe('1')
  })
  it('does not permit a foreign optional conversation binding in a canonical provider proposal',()=>{
   const foreign='99999999-9999-4999-8999-999999999992';ok(`INSERT INTO public.threads(id,organization_id,mailbox_id,subject,participant_email) VALUES('${foreign}','${ids.otherOrg}','${ids.account}','Other','other@example.test')`)
   const r=effect('recordInboundBridge',{leadId:ids.lead,threadId:foreign,sourceId:'fixture-source',payloadFingerprint:'a'.repeat(64),proposal:{body:'Fixture'}});expect(r.code).not.toBe(0);expect(ok('SELECT count(*) FROM public.outreach_closebot_bridge')).toBe('0')
  })

})
