#!/usr/bin/env node
/**
 * Preflight and runner for the PostgreSQL-backed integration shard.
 *
 * Every required environment variable is validated BEFORE any test process is
 * started, so a missing or unsafe fixture target fails loudly instead of letting
 * `describe.skipIf(!url)` silently skip real database coverage. Pass `--check`
 * to validate the environment only (used by CI before the full suite).
 *
 * Safety contract: each URL must be postgres://127.0.0.1:55439/<exact database>
 * with no query string. Production Supabase credentials are never consulted.
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { readdirSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const HOST = '127.0.0.1'
const PORT = '55439'

/** env variable -> the one disposable database and test file it proves. */
const FIXTURES = [
  { env: 'WINNR_TEST_DATABASE_URL', database: 'winnr_test', test: 'tests/integration/winnr.test.ts' },
  { env: 'OUTREACH_TEST_DATABASE_URL', database: 'outreach_test', test: 'tests/integration/outreach-events.test.ts' },
  { env: 'OUTREACH_CAMPAIGN_TEST_DATABASE_URL', database: 'campaign_core_test', test: 'tests/integration/campaign-core.test.ts' },
  { env: 'SUPPRESSION_TEST_DATABASE_URL', database: 'coldforge_suppression_test', test: 'tests/integration/suppression-postgres.test.ts' },
  { env: 'IDENTITY_TEST_DATABASE_URL', database: 'coldforge_identity_test', test: 'tests/integration/identity-postgres.test.ts' },
  { env: 'WINNR_SMTP_TEST_DATABASE_URL', database: 'winnr_smtp_test', test: 'tests/integration/winnr-smtp.test.ts' },
  { env: 'EMAIL_DISPATCH_TEST_DATABASE_URL', database: 'email_dispatch_test', test: 'tests/integration/email-dispatch.test.ts' },
  { env: 'WINNR_INGESTION_TEST_DATABASE_URL', database: 'winnr_ingestion_test', test: 'tests/integration/winnr-ingestion.test.ts' },
  { env: 'LEAD_VALIDATION_TEST_DATABASE_URL', database: 'coldforge_lead_validation_test', test: 'tests/integration/lead-validation.test.ts' },
  { env: 'OUTREACH_REPLIES_TEST_DATABASE_URL', database: 'outreach_replies_test', test: 'tests/integration/outreach-replies.test.ts' },
  { env: 'OUTREACH_AGENTS_TEST_DATABASE_URL', database: 'outreach_agents_test', test: 'tests/integration/outreach-agents.test.ts' },
  { env: 'OUTREACH_OPERATIONS_TEST_DATABASE_URL', database: 'outreach_operations_test', test: 'tests/integration/outreach-operations-postgres.test.ts' },
  { env: 'OUTREACH_RECONCILIATION_TEST_DATABASE_URL', database: 'outreach_reconciliation_test', test: 'tests/integration/outreach-reconciliation.test.ts' },
  { env: 'OUTREACH_DOWNSTREAM_TEST_DATABASE_URL', database: 'outreach_downstream_test', test: 'tests/integration/outreach-downstream.test.ts' },
  { env: 'OUTREACH_MAIL_LOOP_TEST_DATABASE_URL', database: 'outreach_mail_loop_test', test: 'tests/integration/outreach-mail-loop.test.ts' },
  { env: 'OUTREACH_CHAIN_TEST_DATABASE_URL', database: 'coldforge_outreach_chain_test', test: 'tests/integration/outreach-migration-chain.test.ts' },
]

function validate() {
  const problems = []
  for (const { env, database } of FIXTURES) {
    const raw = process.env[env]
    if (!raw) {
      problems.push(`${env} is not set (expected postgres://${HOST}:${PORT}/${database})`)
      continue
    }
    let parsed
    try {
      parsed = new URL(raw)
    } catch {
      problems.push(`${env} is not a valid URL`)
      continue
    }
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
      problems.push(`${env} must use the postgres protocol`)
    } else if (parsed.hostname !== HOST || parsed.port !== PORT) {
      problems.push(`${env} must target ${HOST}:${PORT}, not ${parsed.hostname}:${parsed.port}`)
    } else if (parsed.pathname !== `/${database}`) {
      problems.push(`${env} must target /${database}, not ${parsed.pathname}`)
    } else if (parsed.search || parsed.hash) {
      problems.push(`${env} must not carry query parameters or a fragment`)
    }
  }
  return problems
}

// Fail closed when a new additive migration arrives without a release-gate review.
const expectedMigrations = [
 '020_winnr_connections.sql','021_outreach_event_spine.sql','022_campaign_core.sql',
 '023_outreach_suppression.sql','024_email_dispatch.sql','025_identity_bootstrap.sql',
 '026_winnr_smtp.sql','027_winnr_ingestion.sql','028_lead_validation.sql',
 '029_email_replies.sql','030_outreach_agents.sql','031_outreach_operations.sql','032_outreach_reconciliation.sql','033_outreach_downstream.sql',
]
const discovered = readdirSync('supabase/migrations').filter(file => /^\d+_.*\.sql$/.test(file) && Number(file.split('_')[0]) >= 20).sort()
const problems = validate()
if (JSON.stringify(discovered) !== JSON.stringify(expectedMigrations)) problems.push('Additive migration registry differs from discovered020+ files; update required suites/chain contract before release')
for (const fixture of FIXTURES) {
 try { readFileSync(fixture.test) } catch { problems.push(`Required PostgreSQL suite missing: ${fixture.test}`) }
}

if (problems.length > 0) {
  console.error('PostgreSQL fixture environment is incomplete or unsafe:')
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('\nRefusing to run: a skipped PostgreSQL test is not a passing test.')
  process.exit(1)
}

console.log(`PostgreSQL fixture environment verified for ${FIXTURES.length} databases.`)
if (process.argv.includes('--check')) process.exit(0)

// Roles are cluster-global: create them once serially before parallel per-database DDL.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PG')))
const roles = spawnSync(process.env.PSQL?.trim() || 'psql', ['-X','-v','ON_ERROR_STOP=1','--dbname',process.env[FIXTURES[0].env]], {
 env, encoding:'utf8', stdio:['pipe','inherit','inherit'], input: `DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
 END $$;`,
})
if (roles.error) throw roles.error
if (roles.status !== 0) process.exit(roles.status ?? 1)
const tests = FIXTURES.map((fixture) => fixture.test)
const vitest = path.join('node_modules', '.bin', process.platform === 'win32' ? 'vitest.cmd' : 'vitest')
const reportDir = mkdtempSync(path.join(tmpdir(),'coldforge-postgres-gates-'))
const report = path.join(reportDir,'vitest.json')
try {
 const result = spawnSync(vitest, ['run', ...(process.argv.includes('--all-integration')?['tests/integration']:tests),'--reporter=default','--reporter=json',`--outputFile.json=${report}`], { stdio:'inherit',env })
 if (result.error) throw result.error
 if (result.status !== 0) process.exitCode = result.status ?? 1
 else {
  const evidence = JSON.parse(readFileSync(report,'utf8'))
  const missing = FIXTURES.filter(fixture => {
   const suite = evidence.testResults.find(result => result.name === path.resolve(fixture.test))
   return !suite || !suite.assertionResults.length || suite.assertionResults.some(test => test.status !== 'passed')
  })
  if(missing.length) { console.error('Required database coverage skipped or absent:',missing.map(f=>f.test).join(', '));process.exitCode=1 }
  else console.log(`Required PostgreSQL coverage proved: ${FIXTURES.length} suites; no skipped assertions.`)
 }
} finally { rmSync(reportDir,{recursive:true,force:true}) }
