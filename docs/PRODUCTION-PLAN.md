# Production Plan — What Is Left

Written 2026-08-23 against `docs/upmax-queen-production-roadmap` @ `79801a0` plus
the uncommitted Wave 0 / SEC-002 work. Every claim below is grounded in a check
run against this tree; evidence is cited inline.

Supersedes nothing — this is the execution ordering for
`docs/PRODUCTION-ROADMAP.md`, with verified current state substituted for the
assumptions the roadmap was written under.

## Where the codebase actually is

**What exists and works:** a standalone cold-email tool. 167 API routes, 43 lib
modules, 18 migrations. Campaigns, leads, inbox/IMAP, SMTP sending, warmup pool,
domains/DNS, mailbox provisioning, analytics, billing, white-label. 360 unit and
integration tests pass, lint is clean.

**What does not exist:** the Upmax product architecture.

| Component | Status |
| --- | --- |
| Winnr (domains, mailboxes, warming, SMTP/IMAP) | **zero code** — appears only in `docs/` |
| GHL (CRM, contacts, opportunities, calendars) | **zero code** |
| CloseBot (text qualification, booking) | **zero code** |
| Retell (voice) | **zero code** |
| Canonical event ledger / outbox | **zero code** — no `src/lib/events`, no outbox |

The commit `f55ecef` "feat: Complete Wave 1-4 — Production ready release" does not
describe this tree. Waves 1–4 of the roadmap are unstarted.

**Two findings that block any real send, independent of everything else:**

1. **No unsubscribe endpoint exists.** `find src/app -ipath "*unsub*"` returns
   nothing. Yet `src/lib/sending/sender.ts:242` emits
   `List-Unsubscribe-Post: List-Unsubscribe=One-Click` — and there is no
   `List-Unsubscribe` header to pair it with. Every commercial email this system
   sends today advertises one-click unsubscribe, points nowhere, and omits the
   header that makes the advertisement valid.
2. **Suppression is partial, non-atomic, and not on every send path.**
   *(Corrected 2026-08-24 — an earlier revision of this document claimed no
   suppression check existed at all. That was wrong; it was grepped from the
   campaign path rather than the SMTP queue path.)*

   What exists: `email_suppressions` (migration `010_smtp_infrastructure.sql`,
   present in generated types), `isEmailSuppressed()` at
   `src/lib/smtp/queue.ts:279` checking email + `is_active` + global-or-workspace
   scope, called before send at line 302, and `src/lib/smtp/webhooks.ts:360`
   writing suppressions on bounce/complaint.

   What is wrong with it:
   - **Not atomic.** The check is a separate `SELECT` before the send, so a
     suppression written between check and send is missed. SEC-006 and CAM-007
     require one atomic transaction; this is a time-of-check/time-of-use gap.
   - **Only guards `email_queue`.** `src/lib/warmup/*`,
     `src/app/api/inbox/[id]/reply/route.ts` and
     `src/app/api/replies/[id]/respond/route.ts` call `sendEmail()` directly with
     no suppression check at all.
   - **No unsubscribe writes into it.** Only bounce and complaint do, because
     there is no unsubscribe endpoint to record one.

3. **The campaign send path is a stub that reports success.**
   `src/app/api/sending/process/route.ts:317` computes the email and discards it
   with `void prepareEmail(...)`, then sets `const sendSuccess = true` and writes
   `status: 'sent'` with a generated message_id to `email_jobs`. Nothing is sent.
   This is a placeholder on a production path, which the constitution prohibits
   (FND-012).

Together these are a CAN-SPAM exposure and a Gmail/Yahoo bulk-sender compliance
failure. They are items 3 and 3 respectively — nothing ships past them.

## Completed this session

FND-001 (baseline), FND-002 (test failures), FND-003 (lint), FND-006 (env schema
+ startup validation), FND-008 (scripts + CI), SEC-002 (webhook fail-closed).
FND-013 partial (Node 24 pinned; compatibility unverified locally).

Tests 312→360 passing, lint 38 errors→0, 0 new type errors.

---

## The ten

Ordered by what blocks what, not by size.

### 1. Schema truth — reconcile live DB, migrations, and generated types

**Blocked on:** Supabase credentials (human gate).

The repository disagrees with itself about the database in three directions:

- 11 tables the app queries **234 times** have no DDL anywhere — not in
  `supabase/migrations/`, not in `SETUP_SUPABASE_CLOUD.sql`. Worst offenders:
  `workspace_members` (75 call sites), `profiles` (57), `mailboxes` (33),
  `email_jobs` (21).
- 25 tables have migrations but no generated types, including `invoices`,
  `coupons`, `audit_logs`, `dead_letter_queue` and five `warmup_*` tables.
- The migration set **does not apply from scratch**: `supabase start` fails at
  `007_warmup_pool.sql` because `warmup_emails` is created by both 001 and 007,
  and `warmup_schedules` by both 007 and 010.

`src/types/database.ts` has been hand-maintained, so the compiler cannot detect
any of this.

**Work:** dump the live schema → adopt it as a squashed `000_baseline.sql` →
forward-only from there → regenerate `src/types/database.ts` from the local stack
→ delete the hand edits. Then remove the boundary casts left in
`src/lib/warmup/slow-ramp.ts`.

**Unblocks:** 2, 4, 5, and every migration-dependent item after.
**Size:** 3–5 days once credentials land.

### 2. Typecheck and build green

**Depends on:** 1.

`npx tsc --noEmit` crashes with `RangeError: Map maximum size exceeded`, bisected
to a single file: `src/lib/billing/invoices.ts` queries `invoices`, absent from
the generated types, so every `from('invoices')` resolves to the
`relation: never` overload and the builder type exceeds V8's Map limit.

Behind the crash sit **1,155 further type errors**. This project has never been
typecheckable, and `npm run build` has never succeeded.

CI job `typecheck-and-build` is deliberately red and tracks exactly this. Do not
silence it.

**Work:** fix the crash via 1, then burn down 1,155 errors. Roughly 40% are
schema-derived and evaporate with correct types; the rest are real
`strictNullChecks` / `noUncheckedIndexedAccess` violations.

**Size:** 5–8 days. Largest single line item.

### 3. Compliance: unsubscribe, suppression, sending identity

**Depends on:** nothing. **Start immediately, in parallel with 1.**

Covers SEC-004, SEC-005, SEC-006, SEC-007, CAM-007.

- Build the single-step unsubscribe endpoint and confirmation UX, and emit a
  real `List-Unsubscribe` header alongside the existing `-Post` companion.
- Build the global suppression ledger — cross-tenant per policy.
- Add an **atomic** pre-send eligibility transaction: suppression, bounce,
  complaint, opt-out, booking, DNC, quiet hours, timezone, frequency caps —
  checked in one transaction immediately before send, not earlier.
- Accurate identity and postal address on every commercial email.

**Size:** 4–6 days. **This is the true gate on sending anything to a real
recipient.**

### 4. Tenancy consolidation and RLS

**Depends on:** 1.

Two incompatible tenancy models are live simultaneously.
`organizations`/`organization_members` (real DDL, 17 call sites) and
`workspaces`/`workspace_members` (no DDL, 87 call sites), split across routes by
authorship accident: `warmup/*` authorizes against `organization_members` while
`reputation/*`, `integrations/*`, `smtp-providers/*`, `email-queue` and
`oauth/authorize` authorize against `workspace_members`.

Decision taken: **standardize on `workspaces`/`workspace_members`.** Needs an ADR.

**Work:** migrate the 17 stragglers, write RLS policies for every table, add
negative authorization tests (SEC-008) proving tenant A cannot read tenant B.

**Size:** 4–6 days.

### 5. Real test harness

**Depends on:** 1 (migrations must apply).

FND-009, FND-011. Today's "integration" tests are in-memory mocks — 58 of them,
touching no real Supabase, Redis, or provider. They cannot catch RLS bugs, schema
drift, or transaction semantics, which is precisely the class of defect this
codebase has.

**Work:** disposable Postgres + Redis via the local Supabase stack, a controlled
mail sink, migration validate/reset/backup/restore workflows.

**Size:** 3–4 days.

### 6. Event ledger and outbox

**Depends on:** 1, 5.

EVT-001..006. The constitution's source-of-truth rule: *"Every external event
enters Upmax through the canonical event ledger before producing downstream
effects. All consumers must be idempotent."* None of this exists.

**Work:** canonical event envelope and version policy, provider receipt table
with uniqueness, transactional outbox and workers, consumer idempotency
receipts, DLQ + replay + reconciliation, lag metrics.

SEC-002 added replay protection to one endpoint; SEC-003 (deduplication) belongs
here.

**Size:** 5–7 days. This is the architectural spine — every later integration
depends on it, so it cannot be deferred past item 7.

### 7. Winnr integration

**Depends on:** 6.

WIN-001..009. Zero code exists. This is the actual product bet — replacing
Mailscale and Instantly — and it is entirely unbuilt.

**Work:** typed client with auth/timeout/retry/rate-limit/error taxonomy; domain
purchase/connect/status; mailbox create/bulk/status/credentials; warming
enable/settings/metrics; inbox/thread/message ingestion; send + SMTP selection +
message-ID mapping; async job polling; health/capacity cache with automatic
quarantine; contract fixtures and a sandbox suite.

**Requires:** Winnr API credentials and a test account (human gate).
**Size:** 8–12 days.

### 8. Campaign engine consolidation

**Depends on:** 3, 6, 7.

CAM-001..010. There are currently competing send paths (`src/lib/sending/`,
`src/lib/smtp/queue.ts`, `src/lib/queue/processors/campaign.ts`). Release A needs
exactly one canonical campaign and lead state machine.

**Work:** one state machine; sequence scheduler with timezone and quiet-hour
behaviour; capacity-aware healthy-mailbox allocator; deterministic idempotency
key per planned touch; template/variable/spintax validation with immutable
versions; approval state; stop transitions on reply/bounce/complaint/opt-out/
booking with race and duplicate-event tests; pause/resume/cancel/recovery.

**Size:** 8–10 days.

### 9. Reply-to-appointment loop

**Depends on:** 6, 7, 8.

GHL-001..009, CB-001..005. Zero code exists. This is where revenue actually
happens — the mission is booked, attended, qualified appointments, not email
volume.

**Work:** GHL OAuth with scoped tokens and encrypted storage; contact and
custom-field mapping; opportunity pipeline/stage mapping; calendar free-slot and
appointment adapter; **Ed25519** webhook verification; the Upmax custom email
conversation provider; Winnr→GHL inbound bridge and GHL→Winnr outbound bridge;
CloseBot source/job-flow, qualification schema, objection and escalation paths,
booking mapping; human escalation for pricing, legal, hostile, ambiguous and
low-confidence replies.

**Requires:** GHL and CloseBot credentials (human gate).
**Size:** 10–14 days.

### 10. Operational readiness and pilot gate

**Depends on:** all of the above.

OPS-001..005, FND-012, plus the release checklist.

- Remove production-path placeholders — **84 TODO/FIXME/placeholder hits** remain
  in `src/`.
- **FND-012:** delete the `'instantscale-default-salt'` fallback at
  `src/lib/encryption.ts:15`. Startup validation now requires `ENCRYPTION_SALT`
  in production, but a predictable salt is still reachable in code.
- Structured logging with correlation/tenant/campaign/lead/event IDs and
  redaction; queue/provider/booking funnel dashboards; alert policies and
  incident runbooks.
- Backup, restore, deploy, rollback and disaster drills. Provider outage and
  failover tests. Load and queue-recovery tests.
- Security review and threat model (SEC-001, SEC-009, SEC-010, SEC-011).
- Internal pilot on seed recipients → owner-approved limited live cohort. No
  automatic broad rollout.

**Size:** 6–8 days.

---

## Critical path

```
1 schema ──► 2 typecheck/build ──► 5 harness ──► 6 events ──► 7 Winnr ──► 8 campaign ──► 9 GHL/CloseBot ──► 10 pilot
        └──► 4 tenancy/RLS ──────────────────────────────────────────────┘
3 compliance ── parallel, blocks only the first real send ────────────────┘
```

Item 3 runs in parallel from day one; it needs no credentials and gates sending
rather than building.

**Rough total: 55–80 working days of engineering** before an owner-approved
production pilot, assuming credentials arrive promptly and vendor sandboxes
behave. This is substantially longer than `PRODUCTION-ROADMAP.md`'s Day 25–35
pilot gate, because that roadmap assumed a working baseline. There isn't one.

## Blocked on you

| Need | Unblocks | Gate |
| --- | --- | --- |
| Supabase project ref + read-capable connection string | 1, 2, 4, 5 | credentials |
| Winnr API credentials + test account | 7 | credentials + plan |
| GHL OAuth app / private integration token | 9 | credentials |
| CloseBot account and job-flow access | 9 | credentials |
| Approval to send to real recipients | 10 | audience + content + limits + kill switch |

Item 1 is the tightest constraint: four of ten items sit behind it, and it needs
one connection string.
