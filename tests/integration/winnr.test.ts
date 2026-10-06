/**
 * Real PostgreSQL integration contract for migration 020
 * (`supabase/migrations/020_winnr_connections.sql`).
 *
 * Unlike a mocked Supabase client, this suite applies the migration to a real
 * disposable PostgreSQL 17 cluster and exercises the SQL functions directly
 * through the locally installed `psql` binary (safe argv, no shell
 * interpolation, SQL delivered on stdin).
 *
 * Safety:
 *   - It only runs when `WINNR_TEST_DATABASE_URL` is set. Without it the suite
 *     is skipped honestly (no simulated success).
 *   - The URL must point at the dedicated fixture:
 *       host 127.0.0.1 or localhost, port 55439,
 *       database `winnr_test` or `winnr_test_*`.
 *     Any other value (including an ambient PG* fallback) fails the suite
 *     before a single destructive statement runs.
 *   - Every `beforeEach` reset drops only the objects owned by this contract
 *     (`public.winnr_*`, plus the minimal `organizations`/`users` fixture).
 *     Other environments are never touched.
 *
 * All data is synthetic.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const RAW_URL = (process.env.WINNR_TEST_DATABASE_URL ?? '').trim()
const URL_PRESENT = RAW_URL.length > 0
const PSQL_BIN = (process.env.WINNR_TEST_PSQL ?? 'psql').trim() || 'psql'
const MIGRATION_PATH = path.join(process.cwd(), 'supabase/migrations/020_winnr_connections.sql')
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, 'utf8')

const ORG_A = '11111111-1111-4111-8111-111111111111'
const ORG_B = '11111111-1111-4111-8111-111111111222'
const OP_1 = '33333333-3333-4333-8333-333333333331'
const OP_2 = '33333333-3333-4333-8333-333333333332'
const OP_3 = '33333333-3333-4333-8333-333333333333'

type Guard = { ok: true } | { ok: false; reason: string }

/** Validate the fixture URL using only the provided value (no ambient fallback). */
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
  if (!/^winnr_test(_[a-z0-9_]+)?$/i.test(db)) {
    return { ok: false, reason: `database must be winnr_test or winnr_test_*, got ${db || '(empty)'}` }
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
  killed: boolean
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

/** Run psql with a clean argv and the SQL delivered on stdin. Never uses a shell. */
function runPsql(sql: string, timeoutMs = 20000): Promise<PsqlResult> {
  return new Promise((resolve) => {
    const args = ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-d', RAW_URL]
    const child = execFile(
      PSQL_BIN,
      args,
      { env: childEnv(), timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          ok: error === null,
          code: typeof error?.code === 'number' ? error.code : null,
          killed: Boolean(error?.killed),
          signal: error?.signal ?? null,
          stdout,
          stderr,
        })
      }
    )
    // The callback owns the process; stdin writes are best-effort.
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
  const result = requireOk(await runPsql(sql), context)
  return lastLine(result.stdout)
}

async function queryJson(sql: string, context = 'query'): Promise<Record<string, unknown>> {
  const result = requireOk(await runPsql(sql), context)
  const line = lastLine(result.stdout)
  if (line === '') throw new Error(`${context} returned no row`)
  return JSON.parse(line) as Record<string, unknown>
}

function sqlSave(
  org: string,
  account: string,
  opts: {
    name?: string
    plan?: string | null
    permissions?: string[]
    inbox?: boolean
    expectedId?: string | null
    expectedVersion?: number | null
  } = {}
): string {
  const name = opts.name ?? 'Synthetic Account'
  const plan = opts.plan === undefined ? 'starter' : opts.plan
  const permissions = JSON.stringify(opts.permissions ?? ['read'])
  const inbox = opts.inbox ?? true
  const expectedId = opts.expectedId ?? null
  const expectedVersion = opts.expectedVersion ?? null
  const planSql = plan === null ? 'NULL' : `'${plan}'`
  const expectedIdSql = expectedId === null ? 'NULL' : `'${expectedId}'`
  const expectedVersionSql = expectedVersion === null ? 'NULL' : String(expectedVersion)
  return (
    `SELECT public.winnr_save_connection('${org}','${account}','cipher',` +
    `'${name}',${planSql},'${permissions}'::jsonb,${inbox},${expectedIdSql},${expectedVersionSql}) AS r;`
  )
}

function sqlReserve(
  org: string,
  operationId: string,
  connectionId: string,
  version: number,
  action: string,
  mailboxes: string[],
  fingerprint: string
): string {
  const mailboxJson = JSON.stringify(mailboxes)
  return (
    `SELECT public.winnr_reserve_operation('${org}','${operationId}','${connectionId}',${version},` +
    `'${action}','${mailboxJson}'::jsonb,'${fingerprint}') AS r;`
  )
}

function sqlSettle(org: string, operationId: string, status: string, errorCode: string | null): string {
  const errorSql = errorCode === null ? 'NULL' : `'${errorCode}'`
  return `SELECT public.winnr_settle_operation('${org}','${operationId}','${status}',${errorSql}) AS r;`
}

function sqlDelete(org: string, connectionId: string, version: number): string {
  return `SELECT public.winnr_delete_connection('${org}','${connectionId}',${version}) AS r;`
}

/** Insert the minimal fixture rows and apply migration 020 to a clean schema. */
const RESET_SQL = `
DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname LIKE 'winnr\\_%'
  LOOP
    EXECUTE 'DROP FUNCTION IF EXISTS ' || f.sig || ' CASCADE';
  END LOOP;
END $$;
DROP TABLE IF EXISTS public.winnr_operations CASCADE;
DROP TABLE IF EXISTS public.winnr_connections CASCADE;
DROP TABLE IF EXISTS public.users CASCADE;
DROP TABLE IF EXISTS public.organizations CASCADE;
CREATE TABLE public.organizations (id uuid PRIMARY KEY);
CREATE TABLE public.users (
  id uuid PRIMARY KEY,
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  email text,
  full_name text,
  avatar_url text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Reproduce the live broad profile grants/policies before hardening them.
GRANT SELECT, INSERT, UPDATE ON public.users TO anon, authenticated;
GRANT INSERT (id, email, role, organization_id), UPDATE (role, organization_id)
  ON public.users TO authenticated;
GRANT ALL ON public.users TO service_role;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
CREATE POLICY fixture_self_select ON public.users FOR SELECT USING
  (id = current_setting('fixture.auth_id', true)::uuid);
CREATE POLICY fixture_self_update ON public.users FOR UPDATE USING
  (id = current_setting('fixture.auth_id', true)::uuid);
CREATE POLICY fixture_self_insert ON public.users FOR INSERT WITH CHECK
  (id = current_setting('fixture.auth_id', true)::uuid);
`

const ENSURE_ROLES_SQL = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  -- Supabase's service_role bypasses RLS; mirror that attribute in the fixture
  -- so the suite tests the migration, not a missing fixture capability.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND NOT rolbypassrls) THEN
    ALTER ROLE service_role BYPASSRLS;
  END IF;
END $$;
`

async function seedOrganizations(): Promise<void> {
  await psqlScalar(
    `INSERT INTO public.organizations (id) VALUES ('${ORG_A}'), ('${ORG_B}') ON CONFLICT DO NOTHING;`,
    'seed organizations'
  )
}

async function seedConnection(org: string, account: string): Promise<{ id: string; version: number }> {
  const saved = await queryJson(sqlSave(org, account), 'seed connection')
  if (saved.result !== 'saved') throw new Error(`seed connection was not saved: ${JSON.stringify(saved)}`)
  return { id: String(saved.connection_id), version: Number(saved.version) }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const leakedTablePrivileges = `
SELECT count(*)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('winnr_connections','winnr_operations')
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
  AND p.proname LIKE 'winnr\\_%'
  AND (
    has_function_privilege('anon', p.oid, 'EXECUTE')
    OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
  );
`

describe.skipIf(!URL_PRESENT)('winnr migration 020 PostgreSQL contract', () => {
  beforeAll(async () => {
    if (!GUARD.ok) {
      throw new Error(`WINNR_TEST_DATABASE_URL rejected: ${GUARD.reason}`)
    }
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
    await seedOrganizations()
    requireOk(await runPsql(MIGRATION_SQL), 'apply migration 020')
  }, 30000)

  it('protects membership fields while preserving own profile edits', async () => {
    const user = '44444444-4444-4444-8444-444444444444'
    await psqlScalar(`INSERT INTO public.users (id, organization_id, email) VALUES ('${user}', '${ORG_A}', 'member@example.test');`)
    const browser = `SET ROLE authenticated; SELECT set_config('fixture.auth_id', '${user}', false);`
    requireOk(await runPsql(`${browser} UPDATE public.users SET full_name='Updated profile' WHERE id='${user}';`), 'safe profile update')
    expect(await psqlScalar(`SELECT full_name FROM public.users WHERE id='${user}'`)).toBe('Updated profile')
    for (const assignment of ["role='owner'", `organization_id='${ORG_B}'`, "email='other@example.test'"]) {
      const result = await runPsql(`${browser} UPDATE public.users SET ${assignment} WHERE id='${user}';`)
      expect(result.ok).toBe(false)
      expect(result.stderr).toMatch(/permission denied/i)
    }
    expect(await psqlScalar(`SELECT role || ':' || organization_id FROM public.users WHERE id='${user}'`)).toBe(`member:${ORG_A}`)
  })

  it('denies browser membership inserts, including old column-level grants', async () => {
    const user = '44444444-4444-4444-8444-444444444445'
    const result = await runPsql(`SET ROLE authenticated; SELECT set_config('fixture.auth_id','${user}',false);
      INSERT INTO public.users (id,email,role,organization_id) VALUES ('${user}','fixture@example.test','owner','${ORG_B}');`)
    expect(result.ok).toBe(false)
    expect(result.stderr).toMatch(/permission denied/i)
    expect(await psqlScalar(`SELECT count(*) FROM public.users WHERE id='${user}'`)).toBe('0')
    requireOk(await runPsql(`SET ROLE service_role; INSERT INTO public.users (id,email,role,organization_id)
      VALUES ('${user}','fixture@example.test','owner','${ORG_A}');`), 'trusted membership creation')
  })

  it('applies migration 020 with RLS enabled and privileges confined to service_role', async () => {
    const rls = await psqlScalar(`
      SELECT count(*)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('winnr_connections','winnr_operations')
        AND c.relrowsecurity;
    `)
    expect(rls).toBe('2')

    expect(await psqlScalar(leakedTablePrivileges)).toBe('0')
    expect(await psqlScalar(leakedFunctionPrivileges)).toBe('0')

    const serviceTables = await psqlScalar(`
      SELECT count(*)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('winnr_connections','winnr_operations')
        AND has_table_privilege('service_role', c.oid, 'SELECT')
        AND has_table_privilege('service_role', c.oid, 'INSERT')
        AND has_table_privilege('service_role', c.oid, 'UPDATE')
        AND has_table_privilege('service_role', c.oid, 'DELETE');
    `)
    expect(serviceTables).toBe('2')

    const serviceFunctions = await psqlScalar(`
      SELECT count(*)
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.proname LIKE 'winnr\\_%'
        AND has_function_privilege('service_role', p.oid, 'EXECUTE');
    `)
    expect(Number(serviceFunctions)).toBeGreaterThanOrEqual(4)
  })

  it('does not re-expose privileges when the migration is replayed', async () => {
    requireOk(await runPsql(MIGRATION_SQL), 'migration replay')
    expect(await psqlScalar(leakedTablePrivileges)).toBe('0')
    expect(await psqlScalar(leakedFunctionPrivileges)).toBe('0')
    const rls = await psqlScalar(`
      SELECT count(*)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname IN ('winnr_connections','winnr_operations')
        AND c.relrowsecurity;
    `)
    expect(rls).toBe('2')
  })

  it('protects users trust columns while allowing the profile-editor columns', async () => {
    expect(await psqlScalar(`SELECT has_table_privilege('authenticated', 'public.users', 'UPDATE');`)).toBe('f')
    for (const column of ['full_name', 'avatar_url', 'settings', 'updated_at']) {
      expect(
        await psqlScalar(`SELECT has_column_privilege('authenticated', 'public.users', '${column}', 'UPDATE');`)
      ).toBe('t')
    }
    for (const column of ['role', 'organization_id', 'email', 'id', 'created_at']) {
      expect(
        await psqlScalar(`SELECT has_column_privilege('authenticated', 'public.users', '${column}', 'UPDATE');`)
      ).toBe('f')
    }
    expect(await psqlScalar(`SELECT has_column_privilege('anon', 'public.users', 'full_name', 'UPDATE');`)).toBe('f')
  })

  it('denies anon and authenticated direct ciphertext reads and privileged function calls', async () => {
    const conn = await seedConnection(ORG_A, 'acct-denied')

    for (const role of ['anon', 'authenticated']) {
      const directRead = await runPsql(
        `SET ROLE ${role};\nSELECT token_ciphertext FROM public.winnr_connections LIMIT 1;`
      )
      expect(directRead.ok, `${role} read ciphertext directly`).toBe(false)
      expect(directRead.stderr).toMatch(/permission denied/i)

      const directInsert = await runPsql(
        `SET ROLE ${role};\nINSERT INTO public.winnr_connections (organization_id, provider_account_id, token_ciphertext) VALUES ('${ORG_B}','acct-${role}','cipher');`
      )
      expect(directInsert.ok, `${role} inserted a connection directly`).toBe(false)
      expect(directInsert.stderr).toMatch(/permission denied/i)

      const privilegedCall = await runPsql(
        `SET ROLE ${role};\n${sqlReserve(ORG_A, OP_1, conn.id, conn.version, 'enable', ['mb-1'], 'fp')}`
      )
      expect(privilegedCall.ok, `${role} executed a privileged function`).toBe(false)
      expect(privilegedCall.stderr).toMatch(/permission denied/i)
    }
  })

  it('permits service_role to use the tables and functions', async () => {
    const saved = await queryJson(`SET ROLE service_role;\n${sqlSave(ORG_A, 'acct-svc')}`)
    expect(saved.result).toBe('saved')

    const ciphertext = await psqlScalar(
      `SET ROLE service_role;\nSELECT token_ciphertext FROM public.winnr_connections WHERE provider_account_id = 'acct-svc';`
    )
    expect(ciphertext).toBe('cipher')

    const reserved = await queryJson(
      `SET ROLE service_role;\n${sqlReserve(ORG_A, OP_1, String(saved.connection_id), Number(saved.version), 'enable', ['mb-1'], 'fp-svc')}`
    )
    expect(reserved.result).toBe('reserved')

    const settled = await psqlScalar(
      `SET ROLE service_role;\n${sqlSettle(ORG_A, OP_1, 'succeeded', null)}`
    )
    expect(settled).toBe('t')
  })

  it('enforces global provider-account uniqueness across organizations', async () => {
    const first = await queryJson(sqlSave(ORG_A, 'acct-shared'))
    expect(first.result).toBe('saved')

    const second = await queryJson(sqlSave(ORG_B, 'acct-shared'))
    expect(second.result).toBe('account_taken')

    const distinct = await queryJson(sqlSave(ORG_B, 'acct-distinct'))
    expect(distinct.result).toBe('saved')
  })

  it('rejects stale expected connection id or version on save', async () => {
    const conn = await seedConnection(ORG_A, 'acct-stale')

    const wrongVersion = await queryJson(
      sqlSave(ORG_A, 'acct-stale', { expectedId: conn.id, expectedVersion: 99 })
    )
    expect(wrongVersion.result).toBe('stale')

    const wrongId = await queryJson(
      sqlSave(ORG_A, 'acct-stale', { expectedId: ORG_B, expectedVersion: conn.version })
    )
    expect(wrongId.result).toBe('stale')

    const missingExpectation = await queryJson(sqlSave(ORG_A, 'acct-stale'))
    expect(missingExpectation.result).toBe('stale')
  })

  it('reserves once per operation id and never resubmits after an unknown outcome', async () => {
    const conn = await seedConnection(ORG_A, 'acct-idem')
    const reserve = sqlReserve(ORG_A, OP_1, conn.id, conn.version, 'enable', ['mb-1'], 'fp-1')

    expect((await queryJson(reserve)).result).toBe('reserved')
    expect(await queryJson(reserve)).toMatchObject({ result: 'duplicate', operation_status: 'pending' })

    const mismatch = await queryJson(
      sqlReserve(ORG_A, OP_1, conn.id, conn.version, 'pause', ['mb-1'], 'fp-2')
    )
    expect(mismatch.result).toBe('fingerprint_mismatch')

    expect(await psqlScalar(sqlSettle(ORG_A, OP_1, 'unknown', 'provider_timeout'))).toBe('t')
    expect(await psqlScalar(sqlSettle(ORG_A, OP_1, 'succeeded', null))).toBe('f')

    expect(await queryJson(reserve)).toMatchObject({ result: 'duplicate', operation_status: 'unknown' })
    const unsettled = await queryJson(
      `SELECT row_to_json(t) FROM (SELECT settled_at IS NULL AS unsettled FROM public.winnr_operations WHERE id = '${OP_1}') t;`
    )
    expect(unsettled.unsettled).toBe(true)
  })

  it('holds a mailbox for pending and unknown operations while allowing other mailboxes', async () => {
    const conn = await seedConnection(ORG_A, 'acct-hold')

    expect(
      (await queryJson(sqlReserve(ORG_A, OP_1, conn.id, conn.version, 'enable', ['mb-1'], 'fp-1'))).result
    ).toBe('reserved')

    const blocked = await queryJson(
      sqlReserve(ORG_A, OP_2, conn.id, conn.version, 'pause', ['mb-1'], 'fp-2')
    )
    expect(blocked).toMatchObject({ result: 'blocked', operation_status: 'pending', operation_id: OP_1 })

    const otherMailbox = await queryJson(
      sqlReserve(ORG_A, OP_3, conn.id, conn.version, 'pause', ['mb-2'], 'fp-3')
    )
    expect(otherMailbox.result).toBe('reserved')

    expect(await psqlScalar(sqlSettle(ORG_A, OP_1, 'succeeded', null))).toBe('t')
    const released = await queryJson(
      sqlReserve(ORG_A, OP_2, conn.id, conn.version, 'pause', ['mb-1'], 'fp-2')
    )
    expect(released.result).toBe('reserved')
  })

  it('blocks disconnect while pending and preserves settled operation history', async () => {
    const conn = await seedConnection(ORG_A, 'acct-disc')
    await queryJson(sqlReserve(ORG_A, OP_1, conn.id, conn.version, 'enable', ['mb-1'], 'fp-1'))

    const blocked = await queryJson(sqlDelete(ORG_A, conn.id, conn.version))
    expect(blocked.result).toBe('blocked')
    expect(await psqlScalar(`SELECT count(*) FROM public.winnr_connections WHERE organization_id = '${ORG_A}';`)).toBe('1')

    expect(await psqlScalar(sqlSettle(ORG_A, OP_1, 'succeeded', null))).toBe('t')
    const deleted = await queryJson(sqlDelete(ORG_A, conn.id, conn.version))
    expect(deleted.result).toBe('deleted')

    const history = await queryJson(
      `SELECT row_to_json(t) FROM (SELECT status, connection_id IS NULL AS detached FROM public.winnr_operations WHERE id = '${OP_1}') t;`
    )
    expect(history).toMatchObject({ status: 'succeeded', detached: true })

    const conn2 = await seedConnection(ORG_A, 'acct-disc-2')
    await queryJson(sqlReserve(ORG_A, OP_2, conn2.id, conn2.version, 'enable', ['mb-2'], 'fp-2'))
    expect(await psqlScalar(sqlSettle(ORG_A, OP_2, 'unknown', 'outcome_unknown'))).toBe('t')
    const blockedUnknown = await queryJson(sqlDelete(ORG_A, conn2.id, conn2.version))
    expect(blockedUnknown.result).toBe('blocked')
  })

  it('blocks reconnect on the same provider account while work is pending', async () => {
    const conn = await seedConnection(ORG_A, 'acct-reconnect')
    await queryJson(sqlReserve(ORG_A, OP_1, conn.id, conn.version, 'enable', ['mb-1'], 'fp-1'))

    // Same provider account, same expected id/version: the pending operation
    // must hold the connection, not just an account switch.
    const blocked = await queryJson(
      sqlSave(ORG_A, 'acct-reconnect', { expectedId: conn.id, expectedVersion: conn.version })
    )
    expect(blocked.result).toBe('blocked')

    expect(await psqlScalar(sqlSettle(ORG_A, OP_1, 'succeeded', null))).toBe('t')
    const saved = await queryJson(
      sqlSave(ORG_A, 'acct-reconnect', { expectedId: conn.id, expectedVersion: conn.version })
    )
    expect(saved).toMatchObject({ result: 'saved', version: 2 })
  })

  it('refuses to settle another organization\u2019s operation', async () => {
    const conn = await seedConnection(ORG_A, 'acct-tenant')
    await queryJson(sqlReserve(ORG_A, OP_1, conn.id, conn.version, 'enable', ['mb-1'], 'fp-1'))

    expect(await psqlScalar(sqlSettle(ORG_B, OP_1, 'succeeded', null))).toBe('f')
    expect(await psqlScalar(`SELECT status FROM public.winnr_operations WHERE id = '${OP_1}';`)).toBe('pending')

    expect(await psqlScalar(sqlSettle(ORG_A, OP_1, 'succeeded', null))).toBe('t')
    const foreignDelete = await queryJson(sqlDelete(ORG_B, conn.id, conn.version))
    expect(foreignDelete.result).toBe('not_found')
  })

  it('serializes concurrent reservations so only one process holds the mailbox', async () => {
    const conn = await seedConnection(ORG_A, 'acct-race')

    const [first, second] = await Promise.all([
      runPsql(sqlReserve(ORG_A, OP_1, conn.id, conn.version, 'enable', ['mb-1'], 'fp-1')),
      runPsql(sqlReserve(ORG_A, OP_2, conn.id, conn.version, 'pause', ['mb-1'], 'fp-2')),
    ])
    const parsed = [first, second].map((result, index) => {
      requireOk(result, `concurrent reserve #${index + 1}`)
      return JSON.parse(lastLine(result.stdout)) as Record<string, unknown>
    })
    expect(parsed.map((row) => row.result).sort()).toEqual(['blocked', 'reserved'])

    const pending = await psqlScalar(
      `SELECT count(*) FROM public.winnr_operations WHERE organization_id = '${ORG_A}' AND status IN ('pending','unknown');`
    )
    expect(pending).toBe('1')
  }, 30000)

  it('cannot delete a pending connection while another session holds the row lock', async () => {
    const conn = await seedConnection(ORG_A, 'acct-rowlock')
    await queryJson(sqlReserve(ORG_A, OP_1, conn.id, conn.version, 'enable', ['mb-1'], 'fp-1'))

    const holder = runPsql(
      `SET application_name = 'winnr_row_lock_holder';\n` +
        `BEGIN;\n` +
        `SELECT id FROM public.winnr_connections WHERE organization_id = '${ORG_A}' FOR UPDATE;\n` +
        `SELECT pg_sleep(1.5);\n` +
        `COMMIT;`
    )

    const deadline = Date.now() + 4000
    let lockHeld = false
    while (Date.now() < deadline) {
      const active = await psqlScalar(
        `SELECT count(*) FROM pg_stat_activity WHERE application_name = 'winnr_row_lock_holder' AND query LIKE '%pg_sleep%';`
      )
      if (active === '1') {
        lockHeld = true
        break
      }
      await sleep(50)
    }
    expect(lockHeld).toBe(true)

    const started = Date.now()
    const deleted = await queryJson(sqlDelete(ORG_A, conn.id, conn.version))
    const elapsed = Date.now() - started
    requireOk(await holder, 'row-lock holder transaction')

    expect(deleted.result).toBe('blocked')
    expect(elapsed).toBeGreaterThan(500)
    expect(await psqlScalar(`SELECT count(*) FROM public.winnr_connections WHERE organization_id = '${ORG_A}';`)).toBe('1')
  }, 30000)

  it('prevents an unknown operation from being auto-settled or resubmitted', async () => {
    const conn = await seedConnection(ORG_A, 'acct-unknown')
    await queryJson(sqlReserve(ORG_A, OP_1, conn.id, conn.version, 'enable', ['mb-1'], 'fp-1'))

    expect(await psqlScalar(sqlSettle(ORG_A, OP_1, 'unknown', 'provider_timeout'))).toBe('t')
    expect(await psqlScalar(sqlSettle(ORG_A, OP_1, 'succeeded', null))).toBe('f')
    expect(await psqlScalar(sqlSettle(ORG_A, OP_1, 'rejected', 'operator_abort'))).toBe('f')

    const replay = await queryJson(
      sqlReserve(ORG_A, OP_1, conn.id, conn.version, 'enable', ['mb-1'], 'fp-1')
    )
    expect(replay).toMatchObject({ result: 'duplicate', operation_status: 'unknown' })

    const fresh = await queryJson(
      sqlReserve(ORG_A, OP_2, conn.id, conn.version, 'pause', ['mb-1'], 'fp-2')
    )
    expect(fresh).toMatchObject({ result: 'blocked', operation_status: 'unknown', operation_id: OP_1 })
  })
})
