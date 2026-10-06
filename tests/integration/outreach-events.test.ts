/**
 * Real PostgreSQL integration contract for migration 021
 * (`supabase/migrations/021_outreach_event_spine.sql`).
 *
 * Applies the migration to a disposable PostgreSQL cluster and exercises the
 * SQL functions directly through the locally installed `psql` binary (safe
 * argv, SQL on stdin, no shell interpolation).
 *
 * Safety:
 *   - Runs only when `OUTREACH_TEST_DATABASE_URL` is set. Without it the suite
 *     is skipped honestly (a skip is never reported as a pass).
 *   - The URL must point at the dedicated fixture:
 *       host 127.0.0.1 or localhost, port 55439,
 *       database `outreach_test` or `outreach_test_*`.
 *     Any other value (including an ambient PG* fallback) fails before a
 *     destructive statement runs.
 *   - `beforeEach` drops only fixtures owned by this contract and recreates the
 *     minimal `organizations`/`leads`/`campaigns` rows it needs. Other
 *     environments are never touched.
 *
 * All data is synthetic.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { normalizeOutreachEvent } from '@/lib/outreach/events'

const RAW_URL = (process.env.OUTREACH_TEST_DATABASE_URL ?? '').trim()
const URL_PRESENT = RAW_URL.length > 0
const PSQL_BIN = (process.env.OUTREACH_TEST_PSQL ?? 'psql').trim() || 'psql'
const MIGRATION_PATH = path.join(process.cwd(), 'supabase/migrations/021_outreach_event_spine.sql')
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, 'utf8')

const ORG_A = '11111111-1111-4111-8111-111111111111'
const ORG_B = '11111111-1111-4111-8111-111111111222'
const LEAD_A = '22222222-2222-4222-8222-222222222221'
const LEAD_B = '22222222-2222-4222-8222-222222222222'
const CAMPAIGN_A = '33333333-3333-4333-8333-333333333331'
const LEASE_A = '55555555-5555-4555-8555-555555555551'
const LEASE_B = '55555555-5555-4555-8555-555555555552'
const FINGERPRINT = 'a'.repeat(64)

type Guard = { ok: true } | { ok: false; reason: string }

function validateFixtureUrl(raw: string): Guard {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { ok: false, reason: 'not a parseable URL' }
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    return { ok: false, reason: `unsupported scheme ${parsed.protocol}` }
  }
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    return { ok: false, reason: `host must be 127.0.0.1 or localhost, got ${parsed.hostname || '(empty)'}` }
  }
  if (parsed.port !== '55439') {
    return { ok: false, reason: `port must be 55439, got ${parsed.port || '(empty)'}` }
  }
  const db = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))
  if (!/^outreach_test(_[a-z0-9_]+)?$/i.test(db)) {
    return { ok: false, reason: `database must be outreach_test or outreach_test_*, got ${db || '(empty)'}` }
  }
  for (const key of ['host', 'hostaddr', 'port', 'dbname', 'service']) {
    if (parsed.searchParams.has(key)) {
      return { ok: false, reason: `connection override '${key}' is not allowed` }
    }
  }
  return { ok: true }
}

const GUARD: Guard = URL_PRESENT ? validateFixtureUrl(RAW_URL) : { ok: false, reason: 'not provided' }

/** Strip PG* connection env vars so psql cannot silently fall back to another database. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith('PG')) continue
    env[key] = value
  }
  return env
}

interface PsqlResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
}

function runPsql(sql: string, timeoutMs = 20000): Promise<PsqlResult> {
  return new Promise((resolve) => {
    const args = ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-d', RAW_URL]
    const child = execFile(
      PSQL_BIN,
      args,
      { env: childEnv(), timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ ok: error === null, code: typeof error?.code === 'number' ? error.code : null, stdout, stderr })
      }
    )
    child.stdin?.on('error', () => {})
    child.stdin?.end(sql)
  })
}

function requireOk(result: PsqlResult, context: string): PsqlResult {
  if (!result.ok) {
    throw new Error(`${context} failed (exit ${result.code ?? 'signal'}): ${result.stderr.trim()}`)
  }
  return result
}

function lastLine(output: string): string {
  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return lines.length > 0 ? lines[lines.length - 1] : ''
}

async function psqlScalar(sql: string, context = 'query'): Promise<string> {
  return lastLine(requireOk(await runPsql(sql), context).stdout)
}

async function queryJson(sql: string, context = 'query'): Promise<Record<string, unknown>> {
  const line = lastLine(requireOk(await runPsql(sql), context).stdout)
  if (line === '') throw new Error(`${context} returned no row`)
  return JSON.parse(line) as Record<string, unknown>
}

function esc(value: string): string {
  return value.replace(/'/g, "''")
}

function eventPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    organizationId: ORG_A,
    type: 'lead.replied',
    source: 'winnr',
    sourceEventId: 'evt-0001',
    occurredAt: '2026-10-05T12:00:00.000Z',
    correlationId: null,
    causationId: null,
    subject: { leadId: LEAD_A },
    data: { classification: 'interested' },
    ...overrides,
  }
}

function appendSql(event: Record<string, unknown>, consumers: string[], fingerprint = FINGERPRINT): string {
  return appendSqlAs(String(event.organizationId), event, consumers, fingerprint)
}

function appendSqlAs(
  organizationId: string,
  event: Record<string, unknown>,
  consumers: string[],
  fingerprint = FINGERPRINT
): string {
  const json = esc(JSON.stringify(event))
  const array = consumers.map((c) => `'${esc(c)}'`).join(',')
  return `SELECT public.outreach_append_event('${esc(organizationId)}','${json}'::jsonb,ARRAY[${array}]::text[],'${esc(fingerprint)}') AS r;`
}

/** Raw JSON text so numeric literals JSON.stringify would null out reach jsonb. */
function appendRawSql(
  organizationId: string,
  eventJson: string,
  consumers: string[],
  fingerprint = FINGERPRINT
): string {
  const array = consumers.map((c) => `'${esc(c)}'`).join(',')
  return `SELECT public.outreach_append_event('${esc(organizationId)}','${esc(eventJson)}'::jsonb,ARRAY[${array}]::text[],'${esc(fingerprint)}') AS r;`
}

function eventJsonWithRawData(
  sourceEventId: string,
  dataJson: string,
  occurredAt = '2026-10-05T12:00:00.000Z'
): string {
  return `{"version":1,"organizationId":"${ORG_A}","type":"lead.replied","source":"winnr","sourceEventId":"${sourceEventId}","occurredAt":"${occurredAt}","correlationId":null,"causationId":null,"subject":{},"data":${dataJson}}`
}

function claimSql(org: string, consumer: string, token: string, seconds: number, limit: number): string {
  return `SELECT public.outreach_claim_outbox('${org}','${esc(consumer)}','${token}',${seconds},${limit}) AS r;`
}

function ackSql(org: string, outboxId: string, token: string, expiresAt: string): string {
  return `SELECT public.outreach_ack_outbox('${org}','${outboxId}','${token}','${esc(expiresAt)}') AS r;`
}

function failSql(org: string, outboxId: string, token: string, expiresAt: string, errorCode: string, retryable: boolean): string {
  return `SELECT public.outreach_fail_outbox('${org}','${outboxId}','${token}','${esc(expiresAt)}','${esc(errorCode)}',${retryable}) AS r;`
}

function unknownSql(org: string, outboxId: string, token: string, expiresAt: string, reason: string): string {
  return `SELECT public.outreach_mark_unknown('${org}','${outboxId}','${token}','${esc(expiresAt)}','${esc(reason)}') AS r;`
}

interface ClaimedJob {
  outboxId: string
  eventId: string
  attempts: number
  leaseExpiresAt: string
}

async function claim(org: string, consumer: string, token: string, seconds = 60, limit = 10): Promise<ClaimedJob[]> {
  const result = await queryJson(claimSql(org, consumer, token, seconds, limit), `claim ${consumer}`)
  expect(result.result).toBe('claimed')
  return (result.jobs as ClaimedJob[]) ?? []
}

/** Apply the minimal fixture schema, then migration 021. */
const RESET_SQL = `
DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'outreach\\_%'
  LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS ' || f.sig || ' CASCADE';
  END LOOP;
END $$;
DROP TABLE IF EXISTS public.outreach_outbox CASCADE;
DROP TABLE IF EXISTS public.outreach_events CASCADE;
DROP TABLE IF EXISTS public.leads CASCADE;
DROP TABLE IF EXISTS public.campaigns CASCADE;
DROP TABLE IF EXISTS public.organizations CASCADE;
CREATE TABLE public.organizations (id uuid PRIMARY KEY);
CREATE TABLE public.leads (
  id uuid PRIMARY KEY,
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE
);
CREATE TABLE public.campaigns (
  id uuid PRIMARY KEY,
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE
);
`

const ENSURE_ROLES_SQL = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND NOT rolbypassrls) THEN
    ALTER ROLE service_role BYPASSRLS;
  END IF;
END $$;
`

const SEED_SQL = `
INSERT INTO public.organizations (id) VALUES ('${ORG_A}'), ('${ORG_B}') ON CONFLICT DO NOTHING;
INSERT INTO public.leads (id, organization_id) VALUES ('${LEAD_A}', '${ORG_A}'), ('${LEAD_B}', '${ORG_B}') ON CONFLICT DO NOTHING;
INSERT INTO public.campaigns (id, organization_id) VALUES ('${CAMPAIGN_A}', '${ORG_A}') ON CONFLICT DO NOTHING;
`

const leakedTablePrivileges = `
SELECT count(*)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('outreach_events','outreach_outbox')
  AND (
    has_table_privilege('anon', c.oid, 'SELECT') OR has_table_privilege('anon', c.oid, 'INSERT')
    OR has_table_privilege('anon', c.oid, 'UPDATE') OR has_table_privilege('anon', c.oid, 'DELETE')
    OR has_table_privilege('authenticated', c.oid, 'SELECT') OR has_table_privilege('authenticated', c.oid, 'INSERT')
    OR has_table_privilege('authenticated', c.oid, 'UPDATE') OR has_table_privilege('authenticated', c.oid, 'DELETE')
  );
`

const leakedFunctionPrivileges = `
SELECT count(*)
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname LIKE 'outreach\\_%'
  AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'));
`

async function eventIdFor(sourceEventId: string): Promise<string> {
  return psqlScalar(`SELECT id FROM public.outreach_events WHERE source_event_id='${esc(sourceEventId)}';`)
}

async function forceExpiredLease(outboxId: string): Promise<void> {
  requireOk(
    await runPsql(`UPDATE public.outreach_outbox SET lease_expires_at = now() - interval '1 second' WHERE id='${outboxId}';`),
    'force expired lease'
  )
}

async function forceAvailable(outboxId: string): Promise<void> {
  requireOk(
    await runPsql(`UPDATE public.outreach_outbox SET available_at = now() - interval '1 second' WHERE id='${outboxId}';`),
    'force available'
  )
}

describe.skipIf(!URL_PRESENT)('outreach migration 021 PostgreSQL contract', () => {
  beforeAll(async () => {
    if (!GUARD.ok) throw new Error(`OUTREACH_TEST_DATABASE_URL rejected: ${GUARD.reason}`)
    await new Promise<void>((resolve, reject) => {
      execFile(PSQL_BIN, ['--version'], { env: childEnv(), timeout: 5000 }, (error, stdout) => {
        if (error) {
          reject(new Error(`psql is not runnable at "${PSQL_BIN}": ${error.message}`))
          return
        }
        if (!/psql \(PostgreSQL\)/.test(stdout)) {
          reject(new Error(`unexpected psql --version output: ${stdout.trim()}`))
          return
        }
        resolve()
      })
    })
    requireOk(await runPsql(ENSURE_ROLES_SQL), 'ensure fixture roles')
  }, 30000)

  beforeEach(async () => {
    requireOk(await runPsql(RESET_SQL), 'reset owned schema')
    requireOk(await runPsql(SEED_SQL), 'seed fixture rows')
    requireOk(await runPsql(MIGRATION_SQL), 'apply migration 021')
  }, 30000)

  it('appends the event and every named consumer in one transaction', async () => {
    const created = await queryJson(appendSql(eventPayload(), ['crm.sync', 'inbox.route']))
    expect(created.result).toBe('created')
    expect(await psqlScalar(`SELECT count(*) FROM public.outreach_events;`)).toBe('1')
    expect(await psqlScalar(`SELECT count(*) FROM public.outreach_outbox;`)).toBe('2')
    expect(
      await psqlScalar(
        `SELECT string_agg(consumer, ',' ORDER BY consumer) FROM public.outreach_outbox;`
      )
    ).toBe('crm.sync,inbox.route')
  })

  it('deduplicates identical content and rejects content or consumer conflicts', async () => {
    const first = await queryJson(appendSql(eventPayload(), ['crm.sync']))
    expect(first.result).toBe('created')

    const duplicate = await queryJson(appendSql(eventPayload(), ['crm.sync']))
    expect(duplicate.result).toBe('duplicate')
    expect(duplicate.event_id).toBe(first.event_id)

    const differentData = await queryJson(
      appendSql(eventPayload({ data: { classification: 'hostile' } }), ['crm.sync'])
    )
    expect(differentData.result).toBe('conflict')

    const differentConsumers = await queryJson(appendSql(eventPayload(), ['crm.sync', 'inbox.route']))
    expect(differentConsumers.result).toBe('conflict')

    expect(await psqlScalar(`SELECT count(*) FROM public.outreach_events;`)).toBe('1')
    expect(await psqlScalar(`SELECT count(*) FROM public.outreach_outbox;`)).toBe('1')
  })

  it('rolls the event back when a consumer insert fails', async () => {
    const failed = await runPsql(appendSql(eventPayload({ sourceEventId: 'evt-rollback' }), ['crm.sync', 'crm.sync']))
    expect(failed.ok).toBe(false)
    expect(failed.stderr).toMatch(/duplicate key|unique/i)
    expect(await psqlScalar(`SELECT count(*) FROM public.outreach_events WHERE source_event_id='evt-rollback';`)).toBe('0')
    expect(await psqlScalar(`SELECT count(*) FROM public.outreach_outbox;`)).toBe('0')
  })

  it('rejects malformed raw RPC envelopes before persisting them', async () => {
    const missingVersion = eventPayload({ sourceEventId: 'evt-no-version' })
    delete missingVersion.version
    let deep: Record<string, unknown> = { end: true }
    for (let i = 0; i < 10; i += 1) deep = { next: deep }
    const manyKeys: Record<string, number> = {}
    for (let i = 0; i < 300; i += 1) manyKeys[`k${i}`] = i

    const cases: Array<[string, Record<string, unknown>]> = [
      ['organization_mismatch', eventPayload({ organizationId: ORG_B })],
      ['bad_identity', eventPayload({ type: 123 })],
      ['bad_identity', eventPayload({ type: 'reply\nreceived' })],
      ['bad_identity', eventPayload({ type: 'r\u00e9plied' })],
      ['bad_identity', eventPayload({ source: '   ' })],
      ['unknown_event_key', { ...eventPayload(), extra: true }],
      ['bad_timestamp', eventPayload({ occurredAt: '2026-02-30T12:00:00Z' })],
      ['bad_timestamp', eventPayload({ occurredAt: '2026-10-05T12:00:00' })],
      ['bad_version', missingVersion],
      ['unsupported_version', eventPayload({ version: 2 })],
      ['bad_subject', eventPayload({ subject: { leadId: 123 } })],
      ['bad_subject', eventPayload({ subject: { leadId: 'nope' } })],
      ['data_too_large', eventPayload({ data: { blob: 'x'.repeat(20000) } })],
      ['data_too_deep', eventPayload({ data: deep })],
      ['data_too_many_keys', eventPayload({ data: manyKeys })],
    ]

    for (const [reason, payload] of cases) {
      const result = await queryJson(appendSqlAs(ORG_A, payload, ['crm.sync']))
      expect(result.result, `case ${reason}`).toBe('invalid')
      expect(result.reason, `case ${reason}`).toBe(reason)
    }
    expect(await psqlScalar(`SELECT count(*) FROM public.outreach_events;`)).toBe('0')
    expect(await psqlScalar(`SELECT count(*) FROM public.outreach_outbox;`)).toBe('0')
  })

  it('never lets a malformed raw RPC body poison a valid claim batch', async () => {
    const badOrg = await queryJson(appendSqlAs(ORG_A, eventPayload({ organizationId: ORG_B }), ['crm.sync']))
    expect(badOrg.result).toBe('invalid')
    const badType = await queryJson(
      appendSql(eventPayload({ type: 123, sourceEventId: 'evt-poison' }), ['crm.sync'])
    )
    expect(badType.result).toBe('invalid')
    const valid = await queryJson(appendSql(eventPayload({ sourceEventId: 'evt-valid' }), ['crm.sync']))
    expect(valid.result).toBe('created')

    const claimResult = await queryJson(claimSql(ORG_A, 'crm.sync', LEASE_A, 60, 10))
    expect(claimResult.result).toBe('claimed')
    const jobs = claimResult.jobs as Array<{ event: unknown }>
    expect(jobs).toHaveLength(1)
    for (const job of jobs) {
      expect(() => normalizeOutreachEvent(job.event)).not.toThrow()
    }
  })

  it('rejects non-finite numeric leaves and out-of-range UTC years before queueing', async () => {
    const UTC = "SET TIME ZONE 'UTC';\n"

    const huge = await queryJson(
      UTC + appendRawSql(ORG_A, eventJsonWithRawData('evt-huge-number', '{"score":1e400}'), ['crm.sync'])
    )
    expect(huge.result).toBe('invalid')
    expect(huge.reason).toBe('data_number_out_of_range')

    const tiny = await queryJson(
      UTC + appendRawSql(ORG_A, eventJsonWithRawData('evt-underflow-number', '{"score":1e-400}'), ['crm.sync'])
    )
    expect(tiny.result).toBe('invalid')
    expect(tiny.reason).toBe('data_number_out_of_range')

    const yearOverflow = await queryJson(
      UTC +
        appendSql(
          eventPayload({ sourceEventId: 'evt-year-overflow', occurredAt: '9999-12-31T23:59:59-01:00' }),
          ['crm.sync']
        )
    )
    expect(yearOverflow.result).toBe('invalid')
    expect(yearOverflow.reason).toBe('timestamp_out_of_range')

    const yearUnderflow = await queryJson(
      UTC +
        appendSql(
          eventPayload({ sourceEventId: 'evt-year-underflow', occurredAt: '0001-01-01T00:00:00+01:00' }),
          ['crm.sync']
        )
    )
    expect(yearUnderflow.result).toBe('invalid')
    expect(yearUnderflow.reason).toBe('timestamp_out_of_range')

    // Rejected rows are never persisted and never enter the outbox.
    expect(await psqlScalar(`SELECT count(*) FROM public.outreach_events;`)).toBe('0')
    expect(await psqlScalar(`SELECT count(*) FROM public.outreach_outbox;`)).toBe('0')
    expect(await claim(ORG_A, 'crm.sync', LEASE_A)).toHaveLength(0)

    // A valid boundary event at UTC year 9999 still commits and normalizes.
    const boundary = await queryJson(
      UTC +
        appendSql(
          eventPayload({ sourceEventId: 'evt-year-boundary', occurredAt: '9999-12-31T23:59:59Z' }),
          ['crm.sync']
        )
    )
    expect(boundary.result).toBe('created')
    // A session offset must not render this valid UTC instant as year 10000.
    const receipt = await queryJson("SET TIME ZONE 'Pacific/Kiritimati';\n" + claimSql(ORG_A, 'crm.sync', LEASE_A, 60, 10))
    const claimed = receipt.jobs as ClaimedJob[]
    expect(claimed).toHaveLength(1)
    expect(() => normalizeOutreachEvent(claimed[0].event)).not.toThrow()
  })

  it('persists and reconstructs canonical version 1 in claims', async () => {
    await queryJson(appendSql(eventPayload(), ['crm.sync']))
    expect(await psqlScalar(`SELECT version FROM public.outreach_events;`)).toBe('1')

    const claimResult = await queryJson(claimSql(ORG_A, 'crm.sync', LEASE_A, 60, 10))
    const jobs = claimResult.jobs as Array<{ event: { version: number } }>
    expect(jobs).toHaveLength(1)
    expect(jobs[0].event.version).toBe(1)
    expect(() => normalizeOutreachEvent(jobs[0].event)).not.toThrow()
  })

  it('persists an audit-only event with zero consumers and dedupes the empty set', async () => {
    const first = await queryJson(appendSql(eventPayload({ sourceEventId: 'evt-audit' }), []))
    expect(first.result).toBe('created')
    expect(await psqlScalar(`SELECT count(*) FROM public.outreach_events;`)).toBe('1')
    expect(await psqlScalar(`SELECT count(*) FROM public.outreach_outbox;`)).toBe('0')

    const duplicate = await queryJson(appendSql(eventPayload({ sourceEventId: 'evt-audit' }), []))
    expect(duplicate.result).toBe('duplicate')
    expect(duplicate.event_id).toBe(first.event_id)

    const conflict = await queryJson(appendSql(eventPayload({ sourceEventId: 'evt-audit' }), ['crm.sync']))
    expect(conflict.result).toBe('conflict')
    expect(await psqlScalar(`SELECT count(*) FROM public.outreach_outbox;`)).toBe('0')
  })

  it('rejects a null consumer entry at the trust boundary', async () => {
    const payload = esc(JSON.stringify(eventPayload({ sourceEventId: 'evt-null-consumer' })))
    const result = await queryJson(
      `SELECT public.outreach_append_event('${ORG_A}','${payload}'::jsonb, ARRAY['crm.sync', NULL]::text[], '${FINGERPRINT}') AS r;`
    )
    expect(result.result).toBe('invalid')
    expect(result.reason).toBe('bad_consumer')
  })

  it('rejects a subject that belongs to another organization', async () => {
    const mismatch = await queryJson(
      appendSql(eventPayload({ sourceEventId: 'evt-xorg', subject: { leadId: LEAD_B } }), ['crm.sync'])
    )
    expect(mismatch.result).toBe('invalid')
    expect(mismatch.reason).toBe('subject_tenant_mismatch')
    expect(await psqlScalar(`SELECT count(*) FROM public.outreach_events;`)).toBe('0')
  })

  it('keeps claims and settlements scoped to the event organization', async () => {
    await queryJson(appendSql(eventPayload(), ['crm.sync']))
    const eventId = await eventIdFor('evt-0001')

    expect(await claim(ORG_B, 'crm.sync', LEASE_A)).toHaveLength(0)
    const jobs = await claim(ORG_A, 'crm.sync', LEASE_A)
    expect(jobs).toHaveLength(1)

    const crossOrgAck = await queryJson(ackSql(ORG_B, jobs[0].outboxId, LEASE_A, jobs[0].leaseExpiresAt))
    expect(crossOrgAck.result).toBe('not_found')

    // A direct cross-tenant outbox insert is blocked by the composite FK.
    const direct = await runPsql(
      `INSERT INTO public.outreach_outbox (organization_id, event_id, consumer) VALUES ('${ORG_B}','${eventId}','cross.org');`
    )
    expect(direct.ok).toBe(false)
    expect(direct.stderr).toMatch(/foreign key/i)
  })

  it('grants no browser-role access to tables or functions', async () => {
    expect(await psqlScalar(leakedTablePrivileges)).toBe('0')
    expect(await psqlScalar(leakedFunctionPrivileges)).toBe('0')
  })

  it('fences a stale token and cannot settle a successor claim', async () => {
    await queryJson(appendSql(eventPayload({ sourceEventId: 'evt-fence' }), ['crm.sync']))

    const first = await claim(ORG_A, 'crm.sync', LEASE_A)
    expect(first).toHaveLength(1)
    // A second worker cannot take the in-flight row with a different token.
    expect(await claim(ORG_A, 'crm.sync', LEASE_B)).toHaveLength(0)

    const stale = await queryJson(ackSql(ORG_A, first[0].outboxId, LEASE_B, first[0].leaseExpiresAt))
    expect(stale.result).toBe('stale')

    const wrongExpiry = await queryJson(ackSql(ORG_A, first[0].outboxId, LEASE_A, '2099-01-01T00:00:00.000Z'))
    expect(wrongExpiry.result).toBe('stale')

    const acked = await queryJson(ackSql(ORG_A, first[0].outboxId, LEASE_A, first[0].leaseExpiresAt))
    expect(acked.result).toBe('acked')
  })

  it('lets exactly one of two competing claims win', async () => {
    await queryJson(appendSql(eventPayload({ sourceEventId: 'evt-race' }), ['crm.sync']))
    const [a, b] = await Promise.all([
      queryJson(claimSql(ORG_A, 'crm.sync', LEASE_A, 60, 1), 'competing claim A'),
      queryJson(claimSql(ORG_A, 'crm.sync', LEASE_B, 60, 1), 'competing claim B'),
    ])
    const jobsA = (a.jobs as ClaimedJob[]) ?? []
    const jobsB = (b.jobs as ClaimedJob[]) ?? []
    expect(jobsA.length + jobsB.length).toBe(1)

    const winnerToken = jobsA.length === 1 ? LEASE_A : LEASE_B
    const loserToken = jobsA.length === 1 ? LEASE_B : LEASE_A
    const winnerJob = (jobsA.length === 1 ? jobsA : jobsB)[0]

    const loserAck = await queryJson(ackSql(ORG_A, winnerJob.outboxId, loserToken, winnerJob.leaseExpiresAt))
    expect(loserAck.result).toBe('stale')
    const winnerAck = await queryJson(ackSql(ORG_A, winnerJob.outboxId, winnerToken, winnerJob.leaseExpiresAt))
    expect(winnerAck.result).toBe('acked')
  })

  it('expires a lease to a held unknown state and never replays it', async () => {
    await queryJson(appendSql(eventPayload({ sourceEventId: 'evt-expire' }), ['crm.sync']))
    const jobs = await claim(ORG_A, 'crm.sync', LEASE_A)
    await forceExpiredLease(jobs[0].outboxId)

    const expired = await psqlScalar(`SELECT public.outreach_expire_leases('${ORG_A}');`)
    expect(expired).toBe('1')

    const staleAck = await queryJson(ackSql(ORG_A, jobs[0].outboxId, LEASE_A, jobs[0].leaseExpiresAt))
    expect(staleAck.result).toBe('stale')

    expect(await claim(ORG_A, 'crm.sync', LEASE_B)).toHaveLength(0)
    expect(await psqlScalar(`SELECT status FROM public.outreach_outbox WHERE id='${jobs[0].outboxId}';`)).toBe('unknown')
  })

  it('holds an explicitly unknown job out of automatic retry', async () => {
    await queryJson(appendSql(eventPayload({ sourceEventId: 'evt-unknown' }), ['crm.sync']))
    const jobs = await claim(ORG_A, 'crm.sync', LEASE_A)
    const held = await queryJson(unknownSql(ORG_A, jobs[0].outboxId, LEASE_A, jobs[0].leaseExpiresAt, 'provider_timeout'))
    expect(held.result).toBe('unknown')
    expect(await claim(ORG_A, 'crm.sync', LEASE_B)).toHaveLength(0)
  })

  it('retries an explicit pre-effect failure and fences the old token', async () => {
    await queryJson(appendSql(eventPayload({ sourceEventId: 'evt-retry' }), ['crm.sync']))
    const first = await claim(ORG_A, 'crm.sync', LEASE_A)
    const retry = await queryJson(
      failSql(ORG_A, first[0].outboxId, LEASE_A, first[0].leaseExpiresAt, 'transport_reset', true)
    )
    expect(retry.result).toBe('retryable')

    await forceAvailable(first[0].outboxId)
    const second = await claim(ORG_A, 'crm.sync', LEASE_B)
    expect(second).toHaveLength(1)
    expect(second[0].attempts).toBe(2)

    const stale = await queryJson(ackSql(ORG_A, second[0].outboxId, LEASE_A, first[0].leaseExpiresAt))
    expect(stale.result).toBe('stale')
    const acked = await queryJson(ackSql(ORG_A, second[0].outboxId, LEASE_B, second[0].leaseExpiresAt))
    expect(acked.result).toBe('acked')
  })

  it('stops retrying after the bounded attempt count', async () => {
    await queryJson(appendSql(eventPayload({ sourceEventId: 'evt-bounded' }), ['crm.sync']))
    const first = await claim(ORG_A, 'crm.sync', LEASE_A)
    requireOk(
      await runPsql(`UPDATE public.outreach_outbox SET max_attempts = 2 WHERE id='${first[0].outboxId}';`),
      'set max attempts'
    )
    const retry = await queryJson(
      failSql(ORG_A, first[0].outboxId, LEASE_A, first[0].leaseExpiresAt, 'transport_reset', true)
    )
    expect(retry.result).toBe('retryable')

    await forceAvailable(first[0].outboxId)
    const second = await claim(ORG_A, 'crm.sync', LEASE_B)
    expect(second).toHaveLength(1)
    const terminal = await queryJson(
      failSql(ORG_A, second[0].outboxId, LEASE_B, second[0].leaseExpiresAt, 'transport_reset', true)
    )
    expect(terminal.result).toBe('failed')

    await forceAvailable(second[0].outboxId)
    expect(await claim(ORG_A, 'crm.sync', LEASE_A)).toHaveLength(0)
    expect(await psqlScalar(`SELECT status FROM public.outreach_outbox WHERE id='${first[0].outboxId}';`)).toBe('failed')
  })
})
