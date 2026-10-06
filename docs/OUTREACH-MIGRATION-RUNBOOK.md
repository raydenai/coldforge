# Outreach migration and release gate

This is a local release procedure, not authorization to apply SQL to production.
The committed historical baseline reproduces exactly 14 public tables, 196
columns, 66 constraints and 49 indexes from the sanitized 2026-10-05 snapshot.
Do not replace it with application-generated tables or the incompatible 001–019
migration chain. Preserve existing organizations, users, leads and mailbox rows.

## Schema order and database prerequisite

The fixture installs `auth.users`, Supabase roles and legacy RLS, captures and
compares the historical catalog, then applies every additive file 020–033 in
numeric order. The catalog comparison happens **before** additive migrations;
legitimate later changes cannot rewrite the evidence of the original baseline.
All column/default/check/FK/index assertions remain exact, including all 33
indexes not emitted by historical primary/unique constraints.

PostgreSQL 17 is required for this tested candidate. The parent's read-only
metadata check confirmed the intended live server is 17.6 and installs pgcrypto
and uuid-ossp in `extensions`, not `public`. Migration030 uses the built-in
`pg_catalog.sha256(pg_catalog.convert_to(text,'UTF8'))`, encoded as hex. It does
not depend on resolving extension functions through a pinned `search_path`.
The chain proves030 works with pgcrypto absent and compares ASCII and nonASCII
body hashes against Node SHA256; production keys/providers are never read.
The historical UUID fixture prerequisite remains `uuid-ossp`.

The required runner compares all discovered `020+` SQL files with its reviewed
registry. A newly added migration, following033, blocks preflight until
the chain and required coverage registry are reviewed together. The reviewed033 downstream contract and local TLS mail-loop suite are required. Do not exclude later files
or weaken TypeScript/schema assertions to pass the release gate.

## Disposable fixture targets

Every URL must explicitly point to `127.0.0.1:55439` and the exact database below,
with no query parameters or fragment. These databases may be reset by tests.
No ambient `PG*`, Supabase URL, credential file or production target is used.

| Environment variable | Database |
|---|---|
| WINNR_TEST_DATABASE_URL | winnr_test |
| OUTREACH_TEST_DATABASE_URL | outreach_test |
| OUTREACH_CAMPAIGN_TEST_DATABASE_URL | campaign_core_test |
| SUPPRESSION_TEST_DATABASE_URL | coldforge_suppression_test |
| IDENTITY_TEST_DATABASE_URL | coldforge_identity_test |
| WINNR_SMTP_TEST_DATABASE_URL | winnr_smtp_test |
| EMAIL_DISPATCH_TEST_DATABASE_URL | email_dispatch_test |
| WINNR_INGESTION_TEST_DATABASE_URL | winnr_ingestion_test |
| LEAD_VALIDATION_TEST_DATABASE_URL | coldforge_lead_validation_test |
| OUTREACH_REPLIES_TEST_DATABASE_URL | outreach_replies_test |
| OUTREACH_AGENTS_TEST_DATABASE_URL | outreach_agents_test |
| OUTREACH_OPERATIONS_TEST_DATABASE_URL | outreach_operations_test |
| OUTREACH_RECONCILIATION_TEST_DATABASE_URL | outreach_reconciliation_test |
| OUTREACH_DOWNSTREAM_TEST_DATABASE_URL | outreach_downstream_test |
| OUTREACH_MAIL_LOOP_TEST_DATABASE_URL | outreach_mail_loop_test |
| OUTREACH_CHAIN_TEST_DATABASE_URL | coldforge_outreach_chain_test |

Create those databases on a disposable PostgreSQL17 server. Set each named URL,
then run:

```sh
node scripts/test-outreach-postgres.mjs --check
npm run test:integration:postgres
```

`--check` validates all16 URLs, suite files and the migration registry without
connecting. Normal execution creates shared `anon`, `authenticated` and
`service_role` roles **serially before** parallel per-database fixture tests.
`psql` is resolved from PATH, or the explicit `PSQL` override. All inherited
libpq `PG*` variables are stripped from role bootstrap and the test process.
Missing/unsafe targets, missing suites, nonzero test exit, missing results or
skipped required assertions fail the runner. A skipped database suite never
counts as passing coverage.

CI provisions a fresh PostgreSQL17 service, creates global roles once before
parallel tests, creates all16 fixture databases, and supplies every guarded URL.
It invokes `node scripts/test-outreach-postgres.mjs --all-integration` once for
all integration tests and checks the required database results in the JSON
report. Unit tests, lint, route type generation, full TypeScript and build remain
separate required jobs. A local run on an existing cluster proves the code and
coverage, but does not claim a fresh GitHub Actions execution.

## Cross-module evidence

The complete chain exercises production RPCs using synthetic provider events
and fake transport evidence, without SMTP/IMAP or paid model calls:

- Real028 proof gates024 campaign reserve/authorize; acceptance persists one
  canonical `sent_emails` receipt and advances enrollment.
- Real027 inbound metadata stops a cold enrollment before body fetching;
  complaint suppression blocks an already reserved final authorization.
- Human029 reply preparation binds exact Message-ID, content, sender identity
  and signed opt-out. An unknown authorized attempt is reconciled once by032
  from verified relay evidence while031 master outbound stop remains active.
  Its canonical timeline is visible, the cold sequence stays replied, and the
  same source reply cannot be sent again after the stop is resumed.
- Real030 policy approval binds the prepared fingerprint and current fetched
  body. Explicit029 human takeover invalidates approval and prevents any agent
  reservation through the031 shared send gate. The021 durable decision event
  and outbox are both present.

The individual required029–033 suites additionally cover concurrency, alias
history, tenant/provenance separation, ambiguous outcomes, scheduler fencing,
stop controls and verified reconciliation. The chain supplements those tests;
it does not replace them or assert delivery from SMTP acceptance.

## Before a real cutover

Production application is a separate task. Record current migration versions,
verify a restorable backup, validate extension/runtime compatibility and tenant
membership, then apply one additive file at a time with `ON_ERROR_STOP=1`.
Stop at the first failure. Do not replay the historical baseline onto user data.
Additive migrations are forward changes, including private wrapper functions,
indexes and triggers; restoration or a reviewed corrective migration is the
rollback procedure. Do not describe dropping arbitrary objects as a safe
rollback or assume every file is idempotent.

No production backup, restore, migration, deployment or provider callback is
proved by this runbook. Unknown provider outcomes remain held for verified
reconciliation and never authorize automatic resubmission.

The chain passes an actual030 approved decision into033: a disabled provider
creates no effect;031 master stop keeps a reservation pre-effect; an unknown
settled bridge remains held and a new browser operation ID cannot bypass its
canonical source-reply identity. No downstream provider is called by this test.

The required mail-loop suite uses real Nodemailer, an ephemeral local TLS SMTP
sink and actual020–032 SQL. It proves receipt/inbound-stop/manual reply/opt-out,
pre-effect suppression and master-stop rejection, plus ambiguous SMTP outcome
hold and verified relay reconciliation. Only external metadata and local TLS
factory routing are injected; the production private cancellation adapter is
covered separately, not claimed by this loop. No external recipients are used.
