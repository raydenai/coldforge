# Winnr launch implementation plan

> For agentic workers: use bounded subagent-driven execution; the parent owns contracts, integration, and verification. No nested delegation.

**Goal:** Connect ColdForge to Winnr and provide real mailbox discovery, warming,
sending, and reply handling with truthful outcomes.

**Architecture:** Winnr owns domains, mailbox infrastructure, warming, SMTP/IMAP,
and provider inbox state. ColdForge owns campaigns, policy, send claims, and
operator controls. Use the verified live `organizations`/`users` identity for
this release; do not introduce a second workspace identity into new Winnr code.
This defers the earlier proposed workspace conversion and preserves current data.

**Tech stack:** Existing Next.js 16, Node 24, TypeScript strict, Supabase,
Zod, fetch, and Nodemailer. No additional runtime service or provider.

**Spec:** `docs/PRODUCT-ARCHITECTURE.md`, `docs/INTEGRATION-CONTRACTS.md`,
`docs/LAUNCH-AUDIT-2026-10-05.md`, and the user's 2026-10-05 instruction to go
fully with Winnr supersede the audit's provider-choice question and ADR-007's
open provider-choice status. Public contract: https://app.winnr.app/openapi.yaml,
downloaded 2026-10-05, SHA256
`675267d3d22d098b73ee5379570bd0e6badaac326e7a3e4229822e9f13c1e994`.

## Global constraints

- Preserve existing campaign UI fixes and all unrelated working changes.
- Secrets stay encrypted server-side. No provider token, mailbox password,
  credential export URL, or raw provider failure body enters a browser response
  or logs. Requests go only to the fixed Winnr API origin.
- Membership comes from authenticated `users.organization_id`. Only owner/admin
  can connect or perform provider mutations. Supplied organization IDs are ignored.
- Missing database/config/provider access is explicit, never simulated success.
- GET requests may have bounded retries. Never automatically retry a send,
  mailbox creation, or paid warm-up operation with an uncertain outcome.
- Paid provider actions require deliberate UI confirmation. The agent will not
  activate billing, send mail, migrate production, or deploy during local tests.
- Production changes require the existing runbook's concrete migration/release
  evidence and approval. Prepare and validate those artifacts first.
- No weakened compiler flags, invented live-schema declarations, or skipped
  modules to make the existing build failure disappear.

## Review focus

1. Different tenant/member role cannot read a token or mutate a Winnr account.
2. Timeout after provider acceptance is unknown, with no automatic resend.
3. Missing metrics remain unknown; cursor and page pagination stay distinct.
4. Connection changes invalidate pending operations rather than sending from a
   different Winnr account silently.
5. Warm-up enablement is a charged operation; double clicks and retries do not
   blindly submit it twice.

## Task 1 — Build foundation

Files: start with `src/lib/billing/invoices.ts`; expand ownership only after
measuring compiler diagnostics. Reproduce and remove the inference explosion
without hiding missing-schema errors. Produce the remaining error inventory;
repair bounded groups with schema-backed contracts. Full typecheck and build
must pass before landing or deployment.

## Task 2 — Typed Winnr adapter

Files: `src/lib/winnr/client.ts`, `src/lib/winnr/types.ts`,
`src/lib/winnr/webhook.ts`, and `tests/unit/lib/winnr-*.test.ts`.

Expose `WinnrClient({token, fetch?, timeoutMs?})` with methods `getAccount()`,
`listMailboxes({cursor?,limit?})`, `listDomains({cursor?,limit?})`,
`listWarming({page?,perPage?})`, `getWarmingMetrics(mailboxId)`,
`enableWarming(ids,settings)`, `pauseWarming(id)`, `resumeWarming(id)`,
`disableWarming(ids)`, `listInbox({mailboxId?,cursor?,limit?})`,
`sendMessage({mailboxId,to,subject,body,html?,inReplyTo?,references?})`.
No custom-header or server-idempotency support is assumed for REST sending.

Normalized records:
- Account: `{id,name,plan,permissions,universalInboxEnabled}`.
- Mailbox: `{id,email,name,status,dailyLimit}`; no credentials.
- Domain: `{id,name,status,dnsHealth,checkedAt}`.
- WarmingMailbox: `{id,email,status,healthScore,sent,replies,lastSyncedAt}`;
  metrics are nullable when absent.
- Cursor page: `{items,nextCursor,hasMore}`. Warming page:
  `{items,page,perPage,total}`.
- InboxMessage: `{id,uid,messageId,threadId,from,to,subject,preview,receivedAt,mailbox}`.
- Send outcome: accepted `{messageId}` only if provider says success and returns
  a nonempty ID; otherwise typed rejection or `outcomeUnknown`.

- [x] Fixture tests fail for the initial absent adapter.
- [x] Implement documented request/response parsing, bounds, sanitized errors,
  path encoding, cursor/page separation, and read-only retry behavior.
- [x] Verify HMAC over raw bytes, multiple rotation signatures, 300-second replay
  bounds, malformed signatures, and constant-time comparison.
- [x] Run focused tests and lint; parent verifies the diff and contracts.

## Task 3 — Secure account connection and real infrastructure controls

Files: `src/lib/winnr/server.ts`, `src/lib/winnr/database.ts`,
`src/app/api/winnr/**`, `supabase/migrations/020_winnr_connections.sql`,
`tests/unit/lib/winnr-server.test.ts`, `tests/integration/winnr.test.ts`.

Add organization-scoped encrypted connection and durable provider-operation
records. Service-role tables have RLS with no authenticated secret-read grant.
Resolve membership before using a service client. Connection verification uses
GET `/v1/account`; saving never enables warming. API output uses normalized
records only. Persist an operation reservation before paid/non-idempotent writes;
pending/unknown outcomes block replay and remain reviewable.

Routes: `/api/winnr/connection` GET/POST/DELETE,
`/api/winnr/mailboxes`, `/api/winnr/domains`, `/api/winnr/warming` GET/POST,
`/api/winnr/inbox` GET. POST warming accepts only enable/pause/resume and the
expected connection ID/version, operation UUID, mailbox IDs, and explicit paid
confirmation for enable. Return observed/refreshed provider state, not optimistic
success counts. Do not expose destructive disable in the first UI.

- [x] Prove unauthenticated, cross-tenant, member-write, missing-config, encrypted
  storage, response-redaction, duplicate, and unknown-outcome behaviors.
- [x] Validate forward migration against a disposable database, including RLS
  and uniqueness. Do not apply broken historical migrations to production.

## Task 4 — Winnr operator screen

Files: `src/app/(dashboard)/winnr/page.tsx`,
`src/components/winnr/winnr-dashboard.tsx`, sidebar link, focused UI tests.
Show secure token connection, account state, domains, mailboxes, actual warming
state, pagination and refresh timestamps, explicit paid enable confirmation,
pause/resume, and provider inbox previews. Show errors as errors and absent
metrics as unknown. Keep token out of localStorage and clear it after save.

Local implementation verified: 15 component tests and desktop/mobile fixture
browser checks. Authenticated deployed browser journey remains unverified.

## Task 5 — Campaign and reply execution

After infrastructure contracts pass, consolidate campaign execution onto the live
campaign/sequence schema and one durable send ledger. SMTP over Winnr is needed
where custom unsubscribe headers are required: REST's documented send schema
does not include arbitrary headers. Winnr documents credential exports but their
CSV columns must be verified before an importer claims compatibility. Preserve
unknown-outcome holds, global suppression, limits, pause, replies and bounce
stops; confirm send receipt before sequence advancement. Verify signed webhook
receipt/dedupe and upstream Message-ID mapping. Do not activate old bypass paths.

## Final gates

Full tests/lint/typecheck/build; disposable DB migration/RLS tests; UI check;
independent security review; prepared migration/rollback and release runbook.
Only then request the concrete production approval and controlled test-mail
audience if those have not already been supplied. A fixture-backed connector is
not a live-delivery claim.
