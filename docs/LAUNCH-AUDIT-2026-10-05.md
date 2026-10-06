# ColdForge launch audit — 2026-10-05

**Verdict at the verified pre-cutover checkpoint:** the email-first application
passes local release gates. Real warm-up and sending still require actual
mailboxes, sender readiness and a selected campaign audience. The larger social
outreach roadmap remains future work.

## Verified pre-cutover checkpoint — 2026-10-06

The final integrated candidate passes970 unit tests and325 integration tests,
including all16 required PostgreSQL suites with no skipped assertions. Full
strict TypeScript, route generation and production build pass. Lint reports
zero errors and25 warnings. Independent reviews accepted the retained email,
agent, scheduler, reconciliation, downstream and operator workflows.

Actual local TLS SMTP and PostgreSQL prove campaign acceptance, inbound reply
stops, human reply deduplication, opt-out and unknown receipt reconciliation.
Real downstream RPC orchestration proves contact-to-opportunity progression
with latest applicable qualification. Desktop/mobile pipeline fixtures pass15
checks. External provider effects and public delivery remain unverified.

A private public-schema/data backup of all14 original tables and4 existing rows
restored locally; additive020–033 preserved all original row counts. A dedicated
Vercel project, production environment and auth confirmation URLs are configured.
This document records the source gate before live migrations/deployment; the
release PR records subsequent CI, landing and cutover receipts.

The original diagnostics below document the starting point and do not describe
the current compiler/build status.

## Where work stopped

The local branch reached `d391831352a27239a58c824e084047260fc02d94`, eleven
commits ahead of the published roadmap branch. Later work added signed
unsubscribe tokens and endpoint, suppression checks, an atomic claim RPC,
quiet hours, frequency limits, and safer credential encryption. Campaign
processing was deliberately changed to stop recording sends that never happened.
These are source changes, not evidence of a deployed feature.

The supplied Documents checkout contained cloud placeholders, including Git
objects and test executables. A fresh repository at
`/Users/sezars/projects/coldforge` now preserves the exact local history. The
recovered 662-file HEAD tree matches its original hash; seven missing historical
trees were reconstructed only when their hashes matched exactly. Full Git
integrity and historical-diff checks pass. The original checkout was preserved.

Working branch: `fix/mail-launch-readiness`.
Worktree: `/Users/sezars/projects/coldforge/.claude/worktrees/launch-readiness-20261005`.

## Current measurements

Read-only Supabase CLI discovery matched the project recorded in this repo to
the active **instant scale** project. No production data or schema was changed.
Only schema metadata and aggregate row counts were read; no mailbox credentials,
recipient addresses, message contents, or account keys were retrieved.

| Check | Observed result |
| --- | --- |
| Connected email accounts | **0** |
| Warm-up-enabled accounts | **0** |
| Campaign records | **2** |
| Recorded sent emails | **0** |
| Recorded warm-up emails | **0** |
| Live public tables | **14**, versus **98** declared by repository database types |
| Unit and mock integration tests, recovered baseline | **444 passed**, 19 test files |
| Final tests after campaign UI repair | **451 passed**, 20 test files |
| Lint, recovered baseline | **0 errors**, 170 warnings |
| Typecheck after invoice projection repair | Compiler crash removed; **1,235 errors across 150 files**, no errors in new Winnr production files |
| Production build after repair | Compiles, then fails on existing `next.config.ts` typing; full app remains blocked |
| GitHub deployment and Actions history in raydenai/coldforge | Both APIs returned empty lists; this does not rule out deployment elsewhere |
| Live application URL / browser journey | Not established |

Runtime: Node `v24.21.0`, npm `12.0.2`. Fresh dependencies were installed from
the lockfile with lifecycle scripts disabled. Tests mock Supabase; their success
does not validate live RLS, migrations, worker operation, SMTP, or IMAP.

The live tables are `campaign_leads`, `campaign_sequences`, `campaigns`,
`domains`, `email_accounts`, `lead_lists`, `leads`, `organizations`, `replies`,
`sent_emails`, `thread_messages`, `threads`, `users`, and `warmup_emails`.
The only public functions in generated metadata are `get_user_org_id` and
`is_org_admin`.

## Launch blockers, in dependency order

### 1. The app and live database implement different contracts

Live metadata confirms that `profiles`, `mailboxes`, `email_jobs`, `email_queue`,
`email_suppressions`, `send_claims`, `workspaces`, `workspace_members`,
`organization_members`, and the `claim_send_slot` function do not exist.
Connecting an SMTP account uses `users`/`email_accounts`, but warm-up execution
and campaign actions require `profiles`:
`src/app/api/email-accounts/route.ts:102`,
`src/app/api/warmup/execute/route.ts:60`, and
`src/app/api/campaigns/[id]/actions/route.ts:30`.

Campaign actions select missing `lead_list_ids`/`mailbox_ids` fields and a
nonexistent sequence `steps` JSON field. The live sequence model is individual
step rows (`src/app/api/campaigns/[id]/actions/route.ts:42,90`). Simply changing
types or applying migration 019 cannot fix this: that migration references
nonexistent `workspaces` and `email_suppressions`.

Historical migration 001 and migration 007 both unconditionally create
`warmup_emails` with different columns. This is a static conflict, not a fresh
database migration run in this audit. Do not apply the historical migration set
blindly to production.

### 2. Campaign execution is not connected

`src/app/api/sending/process/route.ts:329` prepares and discards the email;
line 358 sets `sendSuccess = false`. Campaign actions update status but do not
enqueue execution (`src/app/api/campaigns/[id]/actions/route.ts:233`). Worker
factories exist, but the source has no bootstrap caller for `startAllWorkers`
outside `src/lib/queue/workers.ts`.

All four cron paths in `vercel.json` point to nonexistent routes. Wiring cron
or workers alone is insufficient: the BullMQ email processor sends directly
without the newer claim/suppression gate
(`src/lib/queue/processors/email.ts:456-519`). Campaign sequencing advances
after enqueue, before send acceptance
(`src/lib/queue/processors/campaign.ts:654-674`).

### 3. The warm-up toggle is not a running warm-up service

The UI patches an account's `warmup_enabled` and status; the handler does not
schedule or execute work (`src/app/api/warmup/accounts/[id]/route.ts:62-89`).
The direct engine needs a second warm-up-enabled account in the same organization
and returns no tasks when there are no peers
(`src/lib/warmup/engine.ts:207-217`). There is no established external peer pool.

The direct engine marks delivery/open outcomes without inbox evidence
(`src/lib/warmup/engine.ts:399-420`); the separate orchestrator fabricates
engagement using random numbers (`src/lib/warmup/orchestrator.ts:688-719`).
Those metrics cannot establish deliverability or mailbox readiness.

### 4. Connection, sending, and reply ingestion disagree

SMTP connection saves `email_accounts` with encrypted credentials. The direct
warm-up engine can parse that SMTP password format. Inbox sync instead reads
`mailboxes` with different, plaintext credential fields
(`src/app/api/inbox/sync/route.ts:219-241,280-283`).

Google/Microsoft callbacks persist OAuth tokens, but these engines require SMTP
credentials or an SMTP provider; they do not implement token-based sending and
refresh (`src/app/api/auth/google/callback/route.ts:109-118`,
`src/lib/warmup/engine.ts:298-302`). Independent IMAP credentials from the form
are also not preserved by the request schema/creator. OAuth connection success
must not be presented as evidence that this warm-up engine can send.

## Work completed during this audit

- Recovered the exact local commits and a working isolated checkout.
- Reproduced tests, lint, typecheck, and production build on Node 24.
- Located the existing live project and measured schema and aggregate state.
- Corrected campaign list Start/Pause to use `POST /actions`; corrected list and
  detail pages to consume the actual returned `status`, validate it, and surface
  server rejection reasons. Seven new UI tests observed failures before the
  fixes and pass afterward. Parent reran all 451 tests and full lint (zero
  errors, 170 warnings); diff whitespace check passes. This only repairs button
  behavior and does not make the campaign engine operational.

## Fastest path to a usable release

**Owner selected Winnr on 2026-10-05.** Provider choice is settled. Account
creation: [Winnr sign-up](https://app.winnr.app/signup). The public OpenAPI
contract was retrieved and checked. After the owner supplied a token, live GET
checks through the new adapter verified read/write scopes and complete empty
domain, mailbox and warming inventories. No provider mutation occurred.

The local candidate now contains a typed Winnr adapter, encrypted organization
connection, mailbox/domain/inbox reads, paid warm-up confirmation, pause/resume,
durable operation holds, and the `/winnr` operator screen. It replaces no live
deployment yet. Full campaign execution, SMTP credential import, signed event
ingestion and reply automation remain unfinished. The HMAC verifier alone does
not provide an event ingestion pipeline.

A security prerequisite was discovered during review: live metadata confirms
broad `users` UPDATE grants with an own-row policy, allowing changes to role and
organization. The live INSERT policy also permits own-ID profile creation with
arbitrary membership fields. Migration 020 restricts profile edits and removes
browser membership insertion. Real disposable PostgreSQL tests cover both
negative cases while preserving trusted creation and normal profile edits.
**These production permissions have not been changed.** The live `auth.users`
trigger query returned no provisioning trigger; new-user onboarding needs its
own preflight. The existing owner's profile is a separate path.

Next: reconcile the retained app schema/types, clear the complete build gate,
then complete the controlled sending loop over Winnr. The REST send schema
does not document arbitrary headers or idempotency; commercial sequence sending
still needs a verified SMTP contract and the existing eligibility invariants.
See [Winnr release readiness](WINNR-READINESS-2026-10-05.md) for candidate evidence,
configuration, migration safeguards and remaining gates. No API key belongs in
chat or repository files.

## Evidence and handoff

Private local artifacts are in `.local/audits/2026-10-05/` (Git-ignored): live
generated schema, aggregate counts, test/lint/typecheck/build logs, exact-history
recovery report, independent source audit, and worker ledger. These preserve
source provenance without publishing live operational evidence.

No deployment, production migration, provider purchase, real email or campaign
activation occurred. Typecheck/build now pass at the through032 checkpoint;
final033 integration, independent review and remote landing gates remain open.
