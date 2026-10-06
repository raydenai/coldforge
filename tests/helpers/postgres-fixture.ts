/**
 * Shared runner for the disposable PostgreSQL fixture databases.
 *
 * Every helper is deliberately explicit:
 *   * the target database must arrive through the named environment variable,
 *     never an ambient libpq `PG*` variable and never a production Supabase URL;
 *   * the host/port/database are pinned to the local fixture server;
 *   * `psql` is resolved from PATH (override with `PSQL`) so the same tests run
 *     on macOS Homebrew and on the Ubuntu CI runner.
 *
 * This module performs no DDL itself; callers decide when to touch a database.
 */
import { execFileSync } from 'node:child_process'

export const FIXTURE_HOST = '127.0.0.1'
export const FIXTURE_PORT = '55439'

/** Resolve the psql executable portably: an explicit override, else PATH. */
export function psqlExecutable(): string {
  const override = process.env.PSQL?.trim()
  return override && override.length > 0 ? override : 'psql'
}

/** Return a copy of the process environment with every libpq `PG*` variable removed. */
export function strippedEnv(extra: NodeJS.ProcessEnv = { NODE_ENV: 'test' }): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { NODE_ENV: 'test' }
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^PG/.test(key)) clean[key] = value
  }
  return { ...clean, ...extra }
}

export type SafeFixture = { envName: string; url: string; database: string }

/**
 * Validate an explicit disposable fixture URL, or throw before any connection.
 * There is intentionally no fallback to `PG*`, `SUPABASE_*` or any ambient URL.
 */
export function requireSafeFixtureUrl(envName: string, database: string): SafeFixture {
  const raw = process.env[envName]
  if (!raw) throw new Error(`${envName} is not set; refusing to guess a database`)
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`${envName} is not a valid URL`)
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`${envName} must use the postgres protocol`)
  }
  if (parsed.hostname !== FIXTURE_HOST || parsed.port !== FIXTURE_PORT) {
    throw new Error(`${envName} must target the local fixture server ${FIXTURE_HOST}:${FIXTURE_PORT}`)
  }
  if (parsed.pathname !== `/${database}`) {
    throw new Error(`${envName} must target the /${database} fixture database`)
  }
  if (parsed.search || parsed.hash) {
    throw new Error(`${envName} must not carry query parameters or a fragment`)
  }
  return { envName, url: raw, database }
}

function argsFor(url: string, extra: string[] = []): string[] {
  return ['-X', '-v', 'ON_ERROR_STOP=1', '--dbname', url, '-At', ...extra]
}

/** Run a statement and return trimmed stdout; throws on any psql error. */
export function runSql(url: string, statement: string): string {
  return execFileSync(psqlExecutable(), argsFor(url), {
    input: statement,
    env: strippedEnv(),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
}

/** Run a statement and return the process result instead of throwing. */
export function runSqlResult(url: string, statement: string): { code: number; out: string; err: string } {
  try {
    const out = execFileSync(psqlExecutable(), argsFor(url), {
      input: statement,
      env: strippedEnv(),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    return { code: 0, out, err: '' }
  } catch (error) {
    const failed = error as { stderr?: Buffer | string; stdout?: Buffer | string }
    return {
      code: 1,
      out: String(failed.stdout ?? '').trim(),
      err: String(failed.stderr ?? '').trim(),
    }
  }
}
