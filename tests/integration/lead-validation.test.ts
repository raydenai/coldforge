import { psqlExecutable } from '../helpers/postgres-fixture'
/**
 * Disposable PostgreSQL proof for migration 028.
 *
 * Guarded localhost fixture only: 127.0.0.1:55439 / coldforge_lead_validation_test.
 * The ambient PG* environment is stripped so an operator's shell can never
 * redirect the destructive fixture setup at another database.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const url = process.env.LEAD_VALIDATION_TEST_DATABASE_URL

function sql(statement: string) {
  if (!url) throw new Error('Missing explicit fixture URL')
  const parsed = new URL(url)
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '55439' ||
    parsed.pathname !== '/coldforge_lead_validation_test' ||
    parsed.search
  ) {
    throw new Error('Unsafe lead validation fixture URL')
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')))
  return execFileSync(psqlExecutable(), ['-X', '-v', 'ON_ERROR_STOP=1', '--dbname', url, '-At'], {
    input: statement,
    env,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

const orgA = '11111111-1111-4111-8111-111111111111'
const orgB = '22222222-2222-4222-8222-222222222222'
const ownerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const memberA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ownerB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const leadA = '33333333-3333-4333-8333-333333333333'
const leadB = '44444444-4444-4444-8444-444444444444'
const leadC = '55555555-5555-4555-8555-00000000000c'
const leadD = '55555555-5555-4555-8555-00000000000d'
const leadE = '55555555-5555-4555-8555-00000000000e'
const leadF = '55555555-5555-4555-8555-00000000000f'
const leadG = '55555555-5555-4555-8555-000000000010'
const op = (n: number) => `55555555-5555-4555-8555-${String(n).padStart(12, '0')}`

const reserve = (operationId: string, actor = ownerA, org = orgA, lead = leadA) =>
  `SELECT public.lead_validation_reserve_operation('${operationId}','${actor}','${org}','${lead}','zerobounce')::text;`

const finalize = (
  operationId: string,
  status: string,
  providerEmail: string | null,
  actor = ownerA,
  org = orgA,
  lead = leadA,
  sub: string | null = null,
  checkedAt = 'now()',
  reference = 'NULL'
) =>
  `SELECT public.lead_validation_finalize_provider('${operationId}','${actor}','${org}','${lead}','zerobounce',` +
  `${providerEmail === null ? 'NULL' : `'${providerEmail}'`},'${status}',` +
  `${sub === null ? 'NULL' : `'${sub}'`},${reference},${checkedAt})::text;`

const importReport = (
  operationId: string,
  status: string,
  reportedAt = 'now()',
  attested = 'true',
  lead = leadA,
  org = orgA,
  actor = ownerA,
  source = 'FixtureReport',
  reference = 'ref-1'
) =>
  `SELECT public.lead_validation_import_report('${operationId}','${actor}','${org}','${lead}','${status}','${source}','${reference}',${reportedAt},${attested})::text;`

const current = (lead: string, email: string, nowExpr = 'now()', org = orgA) =>
  `SELECT public.lead_validation_is_current('${org}','${lead}','${email}',${nowExpr});`

function json(statement: string): Record<string, unknown> {
  return JSON.parse(sql(statement)) as Record<string, unknown>
}

describe.skipIf(!url)('migration028 real PostgreSQL contract', () => {
  beforeAll(() => {
    sql(`
DROP TABLE IF EXISTS public.lead_validation_evidence, public.lead_validation_operations, public.outreach_suppressions, public.leads, public.users, public.organizations CASCADE;
CREATE TABLE public.organizations(id uuid PRIMARY KEY, name text, slug text UNIQUE, plan text, settings jsonb);
CREATE TABLE public.users(id uuid PRIMARY KEY, organization_id uuid REFERENCES public.organizations, role text);
CREATE TABLE public.leads(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid REFERENCES public.organizations,
  list_id uuid,
  email text NOT NULL,
  first_name text,
  last_name text,
  company text,
  title text,
  phone text,
  linkedin_url text,
  custom_fields jsonb DEFAULT '{}',
  status text DEFAULT 'active' CHECK (status IN ('active','unsubscribed','bounced','complained')),
  validation_status text CHECK (validation_status IN ('valid','invalid','risky','unknown')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.outreach_suppressions(organization_id uuid, normalized_email text, reason text, PRIMARY KEY(organization_id, normalized_email));
INSERT INTO public.organizations VALUES
  ('${orgA}','Alpha','alpha','starter','{}'),
  ('${orgB}','Beta','beta','starter','{}');
INSERT INTO public.users VALUES
  ('${ownerA}','${orgA}','owner'),
  ('${memberA}','${orgA}','member'),
  ('${ownerB}','${orgB}','owner');
INSERT INTO public.leads(id,organization_id,email,status) VALUES
  ('${leadA}','${orgA}','person@example.com','active'),
  ('${leadB}','${orgB}','person@example.com','active'),
  ('${leadC}','${orgA}','import-upgrade@example.com','active'),
  ('${leadD}','${orgA}','vendor-source@example.com','active'),
  ('${leadE}','${orgA}','proof@example.com','active');
`)
    sql(readFileSync('supabase/migrations/028_lead_validation.sql', 'utf8'))
    sql(`
INSERT INTO public.leads(id,organization_id,email,status) VALUES
  ('${leadF}','${orgA}','duplicate@example.com','active'),
  ('${leadG}','${orgA}','duplicate@example.com','active');
`)
  })

  it('reserves durably, is idempotent, and stores a verified provider receipt atomically', () => {
    const reserved = json(reserve(op(1)))
    expect(reserved.state).toBe('reserved')
    expect(reserved.replayed).toBe(false)
    expect(reserved.email).toBe('person@example.com')

    const replay = json(reserve(op(1)))
    expect(replay.replayed).toBe(true)
    expect(replay.state).toBe('reserved')

    const result = json(finalize(op(1), 'valid', 'person@example.com'))
    expect(result.state).toBe('completed')
    expect(result.validationStatus).toBe('valid')

    expect(sql(`SELECT validation_status FROM public.leads WHERE id='${leadA}'`)).toBe('valid')
    expect(
      sql(
        `SELECT verification_level||':'||source FROM public.lead_validation_evidence WHERE organization_id='${orgA}' AND lead_id='${leadA}'`
      )
    ).toBe('verified_provider:zerobounce')
    expect(sql(`SELECT state||':'||validation_status FROM public.lead_validation_operations WHERE id='${op(1)}'`)).toBe('completed:valid')
  })

  it('maps catch-all to risky and spam/abuse traps to invalid without touching suppression', () => {
    sql(`UPDATE public.leads SET validation_status=NULL, email='risky@example.com' WHERE id='${leadA}'`)
    json(reserve(op(2)))
    expect(json(finalize(op(2), 'catch-all', 'risky@example.com')).validationStatus).toBe('risky')

    sql(`UPDATE public.leads SET validation_status=NULL, email='trap@example.com' WHERE id='${leadA}'`)
    json(reserve(op(3)))
    expect(json(finalize(op(3), 'spamtrap', 'trap@example.com')).validationStatus).toBe('invalid')
    expect(sql(`SELECT count(*) FROM public.outreach_suppressions`)).toBe('0')
  })

  it('holds unknown, blocks a new UUID for the same address, and refuses a mismatched claim', () => {
    sql(`UPDATE public.leads SET validation_status=NULL, email='mismatch@example.com' WHERE id='${leadA}'`)
    json(reserve(op(4)))
    const mismatch = json(finalize(op(4), 'valid', 'someone-else@example.com'))
    expect(mismatch.state).toBe('held_unknown')
    expect(mismatch.validationStatus).toBe('unknown')
    // Replaying the held operation settles idempotently and never re-charges.
    const replay = json(finalize(op(4), 'valid', 'mismatch@example.com'))
    expect(replay.replayed).toBe(true)
    expect(replay.state).toBe('held_unknown')

    // A brand-new operation UUID for the same unresolved address is refused.
    expect(() => sql(reserve(op(5)))).toThrow(/unresolved_operation/)

    sql(`UPDATE public.leads SET validation_status=NULL, email='unknown@example.com' WHERE id='${leadA}'`)
    json(reserve(op(6)))
    expect(json(finalize(op(6), 'unknown', 'unknown@example.com')).state).toBe('held_unknown')
    expect(() => sql(reserve(op(7)))).toThrow(/unresolved_operation/)
  })

  it('blocks a new UUID on a duplicate lead row with the same address', () => {
    json(reserve(op(8), ownerA, orgA, leadF))
    expect(json(finalize(op(8), 'unknown', 'duplicate@example.com', ownerA, orgA, leadF)).state).toBe('held_unknown')
    expect(() => sql(reserve(op(9), ownerA, orgA, leadG))).toThrow(/unresolved_operation/)
  })

  it('rejects forged membership, foreign tenants, and a changed lead email (CAS)', () => {
    expect(() => sql(reserve(op(10), memberA, orgA, leadB))).toThrow()
    expect(() => sql(reserve(op(10), ownerA, orgB, leadB))).toThrow()
    expect(sql(`SELECT count(*) FROM public.lead_validation_operations WHERE id='${op(10)}'`)).toBe('0')

    sql(`UPDATE public.leads SET validation_status=NULL, email='cas-before@example.com' WHERE id='${leadA}'`)
    json(reserve(op(11)))
    sql(`UPDATE public.leads SET email='cas-after@example.com' WHERE id='${leadA}'`)
    const cas = json(finalize(op(11), 'valid', 'cas-before@example.com'))
    expect(cas.state).toBe('failed')
    expect(cas.outcome).toBe('email_changed')
    expect(sql(`SELECT state||':'||outcome FROM public.lead_validation_operations WHERE id='${op(11)}'`)).toBe('failed:email_changed')
    expect(sql(`SELECT count(*) FROM public.lead_validation_evidence WHERE lead_id='${leadA}'`)).toBe('0')
  })

  it('resets validation_status and drops evidence when the email changes', () => {
    sql(`UPDATE public.leads SET validation_status=NULL, email='reset@example.com' WHERE id='${leadA}'`)
    json(reserve(op(12)))
    json(finalize(op(12), 'valid', 'reset@example.com'))
    expect(sql(`SELECT validation_status FROM public.leads WHERE id='${leadA}'`)).toBe('valid')
    expect(sql(`SELECT count(*) FROM public.lead_validation_evidence WHERE lead_id='${leadA}'`)).toBe('1')

    sql(`UPDATE public.leads SET email='moved@example.com' WHERE id='${leadA}'`)
    expect(sql(`SELECT coalesce(validation_status,'NULL') FROM public.leads WHERE id='${leadA}'`)).toBe('NULL')
    expect(sql(`SELECT count(*) FROM public.lead_validation_evidence WHERE lead_id='${leadA}'`)).toBe('0')
  })

  it('never revives a suppressed lead to valid', () => {
    sql(`UPDATE public.leads SET validation_status=NULL, email='suppressed@example.com' WHERE id='${leadA}'`)
    sql(`INSERT INTO public.outreach_suppressions VALUES('${orgA}','suppressed@example.com','hard_bounce');`)
    json(reserve(op(13)))
    expect(json(finalize(op(13), 'valid', 'suppressed@example.com')).validationStatus).toBe('invalid')
    expect(sql(`SELECT status FROM public.leads WHERE id='${leadA}'`)).toBe('active')
  })

  it('upgrades an ordinary unknown/no-evidence lead from a fresh valid import', () => {
    const imported = json(importReport(op(14), 'valid', 'now()', 'true', leadC))
    expect(imported.validationStatus).toBe('valid')
    expect(sql(`SELECT validation_status FROM public.leads WHERE id='${leadC}'`)).toBe('valid')
    expect(
      sql(`SELECT verification_level||':'||attested FROM public.lead_validation_evidence WHERE lead_id='${leadC}'`)
    ).toBe('verified_import:true')
  })

  it('requires attestation, bounds the report date to 30 days, and rejects invalid statuses', () => {
    expect(() => sql(importReport(op(15), 'valid', 'now()', 'false', leadD))).toThrow()
    expect(() => sql(importReport(op(16), 'valid', "now() - interval '31 days'", 'true', leadD))).toThrow(/stale_report/)
    expect(() => sql(importReport(op(17), 'valid', "now() + interval '10 minutes'", 'true', leadD))).toThrow(/stale_report/)
    expect(() => sql(importReport(op(18), 'maybe', 'now()', 'true', leadD))).toThrow()
  })

  it('keeps imported verification distinct from a provider label even when the source names a vendor', () => {
    const imported = json(importReport(op(19), 'valid', 'now()', 'true', leadD, orgA, ownerA, 'zerobounce'))
    expect(imported.validationStatus).toBe('valid')
    expect(sql(`SELECT verification_level||':'||source FROM public.lead_validation_evidence WHERE lead_id='${leadD}'`)).toBe('verified_import:zerobounce')
    expect(sql(`SELECT source FROM public.lead_validation_evidence WHERE lead_id='${leadD}'`)).not.toBe('verified_provider')
  })

  it('preserves a retained invalid provider verdict and never reattributes it to a valid import', () => {
    sql(`UPDATE public.leads SET validation_status=NULL, email='provider-invalid@example.com' WHERE id='${leadA}'`)
    json(reserve(op(20)))
    expect(json(finalize(op(20), 'invalid', 'provider-invalid@example.com')).validationStatus).toBe('invalid')
    const imported = json(importReport(op(21), 'valid', 'now()', 'true', leadA))
    expect(imported.validationStatus).toBe('invalid')
    expect(sql(`SELECT validation_status FROM public.leads WHERE id='${leadA}'`)).toBe('invalid')
    expect(sql(`SELECT verification_level||':'||source FROM public.lead_validation_evidence WHERE lead_id='${leadA}'`)).toBe('verified_provider:zerobounce')
    expect(sql(`SELECT receipt->>'preservedPrior' FROM public.lead_validation_operations WHERE id='${op(21)}'`)).toBe('true')
  })

  it('preserves a prior valid receipt when a later timeout/unknown attempt is held', () => {
    json(reserve(op(22), ownerA, orgA, leadE))
    expect(json(finalize(op(22), 'valid', 'proof@example.com', ownerA, orgA, leadE)).validationStatus).toBe('valid')
    const opAfterValid = sql(`SELECT operation_id FROM public.lead_validation_evidence WHERE lead_id='${leadE}'`)

    // A new UUID is allowed because the valid attempt is settled, not unresolved.
    json(reserve(op(23), ownerA, orgA, leadE))
    const held = json(finalize(op(23), 'unknown', null, ownerA, orgA, leadE))
    expect(held.state).toBe('held_unknown')
    // The prior measured fact survives: still valid, same provider evidence.
    expect(held.validationStatus).toBe('valid')
    expect(sql(`SELECT validation_status FROM public.leads WHERE id='${leadE}'`)).toBe('valid')
    expect(sql(`SELECT verification_level FROM public.lead_validation_evidence WHERE lead_id='${leadE}'`)).toBe('verified_provider')
    expect(sql(`SELECT operation_id FROM public.lead_validation_evidence WHERE lead_id='${leadE}'`)).toBe(opAfterValid)
  })

  it('exposes lead_validation_is_current only for fresh, matching, attested proof', () => {
    expect(sql(current(leadE, 'proof@example.com'))).toBe('t')
    expect(sql(current(leadE, 'someone-else@example.com'))).toBe('f')
    expect(sql(current(leadE, 'proof@example.com', 'now()', orgB))).toBe('f')
    expect(sql(current(leadC, 'import-upgrade@example.com'))).toBe('t')

    sql(`UPDATE public.lead_validation_evidence SET checked_at = now() - interval '31 days' WHERE lead_id='${leadE}'`)
    expect(sql(current(leadE, 'proof@example.com'))).toBe('f')
    sql(`UPDATE public.lead_validation_evidence SET checked_at = now() + interval '10 minutes' WHERE lead_id='${leadE}'`)
    expect(sql(current(leadE, 'proof@example.com'))).toBe('f')
    sql(`UPDATE public.lead_validation_evidence SET checked_at = now() WHERE lead_id='${leadE}'`)

    sql(`UPDATE public.lead_validation_evidence SET attested = false WHERE lead_id='${leadC}'`)
    expect(sql(current(leadC, 'import-upgrade@example.com'))).toBe('f')
    sql(`UPDATE public.lead_validation_evidence SET attested = true WHERE lead_id='${leadC}'`)
  })

  it('denies browser writes to validation_status and keeps the other columns usable', () => {
    expect(sql(`SELECT has_column_privilege('authenticated','public.leads','validation_status','UPDATE')`)).toBe('f')
    expect(sql(`SELECT has_column_privilege('authenticated','public.leads','validation_status','INSERT')`)).toBe('f')
    expect(sql(`SELECT has_column_privilege('authenticated','public.leads','first_name','UPDATE')`)).toBe('t')
    expect(() => sql(`SET ROLE authenticated; UPDATE public.leads SET validation_status='valid' WHERE id='${leadA}';`)).toThrow()
    expect(() => sql(`SET ROLE anon; UPDATE public.leads SET first_name='x' WHERE id='${leadA}';`)).toThrow()
  })

  it('exposes validation only through service-role RPCs, tables, and the freshness helper', () => {
    expect(sql(`SELECT has_function_privilege('authenticated','public.lead_validation_reserve_operation(uuid,uuid,uuid,uuid,text)','EXECUTE')`)).toBe('f')
    expect(sql(`SELECT has_function_privilege('anon','public.lead_validation_finalize_provider(uuid,uuid,uuid,uuid,text,text,text,text,text,timestamptz)','EXECUTE')`)).toBe('f')
    expect(sql(`SELECT has_function_privilege('service_role','public.lead_validation_import_report(uuid,uuid,uuid,uuid,text,text,text,timestamptz,boolean)','EXECUTE')`)).toBe('t')
    expect(sql(`SELECT has_function_privilege('authenticated','public.lead_validation_is_current(uuid,uuid,text,timestamptz)','EXECUTE')`)).toBe('f')
    expect(sql(`SELECT has_function_privilege('anon','public.lead_validation_is_current(uuid,uuid,text,timestamptz)','EXECUTE')`)).toBe('f')
    expect(sql(`SELECT has_function_privilege('service_role','public.lead_validation_is_current(uuid,uuid,text,timestamptz)','EXECUTE')`)).toBe('t')
    expect(sql(`SELECT has_table_privilege('authenticated','public.lead_validation_evidence','SELECT')`)).toBe('f')
    expect(sql(`SELECT has_table_privilege('service_role','public.lead_validation_evidence','SELECT')`)).toBe('t')
  })
})
