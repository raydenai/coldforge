# Winnr readiness — 2026-10-05

**Local candidate only. Not deployed, migrated, or approved for real sending.**

Branch `fix/mail-launch-readiness`; worktree
`/Users/sezars/projects/coldforge/.claude/worktrees/launch-readiness-20261005`.
Base commit `d391831352a27239a58c824e084047260fc02d94`. No commit/push/PR was
created because the repository requires the full build gate before publication.

## Implemented and reviewed

- Winnr HTTP adapter with normalized records, bounded GET retry, no mutation
  retry, explicit uncertain outcomes, credential-safe errors, and correlated
  enable/send receipts. Signed-webhook verifier is a utility, not an ingestion
  route. Contract: https://app.winnr.app/openapi.yaml, retrieved 2026-10-05.
- `/api/winnr/connection`, `/mailboxes`, `/domains`, `/warming`, `/inbox`.
  Cookie identity resolves the current user's organization before service-role
  access. Only owner/admin may mutate; provider writes also require token write
  scope. Browser-supplied organization IDs do not control access.
- `/winnr` screen with masked token input, real provider observations,
  pagination, missing metrics shown as unknown, paid warming consent,
  pause/resume, plaintext inbox previews, and operation references for holds.
  Disconnect removes local access; it does not cancel provider warming/billing.
- Migration 020 adds encrypted connections and a durable operation ledger.
  Row locks serialize reservations and connection changes; pending/unknown
  operations block replay, replacement and disconnect. Private tables/functions
  deny browser roles. Membership fields cannot be edited through profile grants.

No stored API key, SMTP password, raw provider error or credential-export URL is
returned to the browser. The provider base URL is fixed and redirects are refused.

## Evidence

Private logs live in `.local/audits/2026-10-05/` (Git-ignored).

- Integrated tests include real PostgreSQL 17, fake provider HTTP, HTTP route
  authorization, component interaction and existing regressions. The PostgreSQL
  suite has 17 cases: ACL/RLS, membership protection, account uniqueness,
  optimistic versions, replay holds, settlement, persistence and actual
  concurrent sessions. All 17 passed.
- Final complete test run: **583 passed across 27 files**. Full lint: **0 errors,
  170 existing warnings**. New Winnr files pass scoped lint with zero warnings.
- Full strict TypeScript check runs without crashing and reports **1,235
  diagnostics across 150 existing files**; no Winnr production-file diagnostics.
  No compiler flags were weakened or production modules excluded.
- Full build compiles application code, then fails on existing
  `next.config.ts` typing (`experimental.instrumentationHook`). This is not the
  only type error.
- Desktop (1440px) and mobile (390px) browser fixture previews were inspected:
  no browser errors or horizontal overflow. This preview used synthetic data
  and proves neither login nor live provider connectivity.
- Independent adapter, backend and UI review found reproducible receipt,
  redaction, RPC binding and membership issues; these were repaired and tested.
  Final scoped review reports no remaining reproduced Winnr findings.

## Configuration and account setup

The owner subsequently supplied an API token. A live read-only check through
the new adapter verified account access and read/write scopes. Complete first
pages reported **0 domains, 0 mailboxes and 0 warming accounts**; universal
inbox was disabled. No provider mutation was attempted. The token was supplied
through hidden standard input, not stored in source or an environment file,
and not sent to workers. On the owner's subsequent instruction, it was saved in macOS Keychain (service `com.coldforge.winnr.api-token`, account `coldforge`), confirmed by metadata-only lookup. Aggregate evidence is in the private audit folder.
Application connection storage and deployment remain pending; API verification
does not mean the account is connected to a deployed ColdForge instance.

Create the provider account at https://app.winnr.app/signup. Follow Winnr's
[API token guide](https://winnr.app/help/api-mcp/api-tokens.html). The application
stores the token encrypted in its own database; it is not a public environment
variable. Read scope is mandatory; write scope is needed for warming controls.

Server requirements: existing Supabase URL/anon key for cookie authentication,
`SUPABASE_SERVICE_ROLE_KEY` for privileged storage, and `ENCRYPTION_SECRET` plus
`ENCRYPTION_SALT` for new credentials. There is no anonymous-key fallback in the
Winnr repository. Set these through the approved deployment secret store.
Never place values in chat, Git, screenshots, worker prompts or logs.

Enable confirmation currently describes the documented $0.60/mailbox/month,
charged upfront and recurring. Verify the current provider charge during the
live preflight. The configured start is 10/day with a slow ramp and 30% response
rate. These are settings, not a deliverability or warm-up-time guarantee.

## Production migration and rollback preparation

Do not execute this procedure until full release gates and owner approval pass.
Only the additive `supabase/migrations/020_winnr_connections.sql` is the proposed
Winnr delta. Historical migrations 001–019 conflict and must not be applied as
an untested batch.

1. Record the exact deployment commit and database target. Capture verified
   backup/restore evidence, the existing `users` grants/policies, and schema.
   Backups contain private data and belong only in the approved private store.
2. Validate the verified live organizations/users columns, service role, and
   profile callers against the migration. Live metadata currently shows **no
   auth.users signup provisioning trigger**. Source-only trigger definitions
   are not proof of installed onboarding. Existing server profile/organization
   fallbacks require genuine service-role configuration.
3. Rerun the guarded disposable PostgreSQL suite and all release gates. Review
   the membership grant changes explicitly: normal profile edits retain access;
   browser role/tenant edits and browser membership inserts lose access.
4. Apply only the reviewed 020 file with fail-on-error. The file contains its
   own BEGIN/COMMIT transaction. Record migration version and re-read ACLs,
   function permissions, RLS and indexes afterward before enabling UI access.
5. Verify the existing owner can connect, that a member cannot mutate, and that
   another organization cannot obtain provider state. Connect itself makes only
   a provider account GET and encrypted local write; it never enables warming.

Operational rollback disables the new application controls/reverts the app
release while retaining the operation ledger and hardened membership grants.
Do not restore the vulnerable browser grants or erase uncertain operations.
Do not assume disconnecting or rolling back ColdForge stops provider warming.
Any provider pause/cancellation or database restore needs its own explicit
target and confirmation, followed by reconciliation of outstanding operations.

## Unknown outcomes

Never resend a pending/unknown operation automatically, even with a new UUID.
The database enforces the hold per mailbox. An authorized operator reviews the
operation ID, action, connection version and mailbox ID against Winnr's current
state and provider activity/billing evidence. Keep the token/ciphertext out of
that review. No timeout alone proves rejection.

An unknown operation has no automatic resolver in this candidate. Manual
reconciliation and an audited terminal update are still required; do not
silently clear a hold from the UI or delete its record.

## Remaining launch gates

- Reconcile schema/tenancy and clear all full-app type/build errors.
- Establish deployed URL, server configuration, secure provider authorization,
  production backup/rollback evidence and approval; migrate and smoke-test.
- Verify Winnr SMTP credentials/export format, custom unsubscribe headers,
  durable send claims, suppression/limits, actual scheduler, receipt-based
  sequence advancement, signed event dedupe and reply/bounce/opt-out stops.
- Run approved test content to owner-designated inboxes and prove receipt,
  replies, opt-out refusal, pause, duplicate refusal and uncertain-send holds.

No production migration, provider purchase, warming enablement, email send,
campaign activation or deployment was performed during this work.
