# Complete outreach system implementation plan

> **For agentic workers:** Use bounded subagent-driven development. The driver owns product decisions, integration, verification, and landing. No nested delegation.

**Goal:** Deliver an operable cold-email system that turns eligible leads into tracked conversations and booked appointments, with shared contracts for later voice, LinkedIn, and social channels.

**Architecture:** Winnr owns email infrastructure and warm-up. ColdForge owns leads, approved campaigns, durable execution, replies, agent decisions, and an operator inbox. GHL owns CRM/calendar records; CloseBot is the planned qualification/booking integration; Retell is the planned voice integration. Provider integrations are replaceable adapters over one organization-scoped event history. Existing organizations/users and real data remain authoritative.

**Tech stack:** Next.js 16, React 19, Node 24, strict TypeScript, Supabase/PostgreSQL, existing Winnr adapter, Vitest. Add no new runtime dependency without a concrete requirement.

**Spec:** `docs/PRODUCT-ARCHITECTURE.md`, `docs/INTEGRATION-CONTRACTS.md`, `docs/LAUNCH-AUDIT-2026-10-05.md`, and the owner's October 5 instruction to manage and execute the complete outreach product without routine approval stops.

## Global constraints

- Cold email is the first complete channel. Later channels must reuse contacts, suppression/preferences, events, agent decisions, and booking state.
- Provider state, delivery, agent activity, appointments, and metrics must come from receipts or persisted records. Missing evidence is unknown.
- Preserve unrelated work and existing tenant data. New code uses organizations/users membership, not an invented parallel workspace.
- Keep strict compiler flags. Retiring obsolete modules must remove their routes, navigation, and runtime callers; excluding broken source from typechecking is not a repair.
- Credentials stay out of source, logs, worker prompts, browser persistence, and reports. Winnr token is stored in macOS Keychain under service `com.coldforge.winnr.api-token`, account `coldforge`.
- All non-idempotent provider operations reserve durable state first. Ambiguous outcomes remain held for reconciliation and never automatically resubmit.
- Build autonomously under the owner's instruction. No routine design approval stop. Domain ownership, paid provisioning quantities, sender identity, recipient/test audience, CRM calendars, and voice eligibility remain concrete launch inputs to collect when necessary.
- No arbitrary real email recipients, phone calls, provider purchases, or broken historical production migration execution during development tests.

## Product surfaces and agent responsibilities

| Surface | Purpose | Agent contract |
| --- | --- | --- |
| Command center | Show launch blockers, actions needing attention, measured campaign/conversation state | Operations agent proposes remedies; cannot manufacture success or silently release unknown sends |
| Infrastructure | Connect Winnr, domains, mailboxes, warm-up and readiness | Deliverability agent observes provider truth and applies approved limits |
| Leads | Import, dedupe, validation, source evidence, suppression and consent/preferences | Research agent enriches with source attribution; validation remains explicit |
| Campaigns | Audience, offer, truthful personalized copy, variants, schedule, mailbox allocation, launch | Copy agent drafts from an offer brief and evidence; policy evaluator rejects unsupported claims/unresolved variables |
| Inbox | Threaded history, intent, owner, response draft, next action, human takeover | Reply agent classifies and drafts; opt-out/bounce/complaint stop campaigns first |
| Pipeline/bookings | Qualification, CRM contact/opportunity, real calendar availability and appointments | Qualification/booking agent uses provider tools and persisted outcomes |
| Voice | Requested/eligible callbacks and follow-up linked to the same lead | Voice agent respects explicit eligibility, local times, stop requests, and booking state |
| Automations | Versioned policies, action history, holds, kill switch, retries/reconciliation | Orchestrator executes typed jobs; agents cannot bypass state/tenant/consent gates |

LinkedIn/social are planned channel adapters, not active integrations or fake connected cards.

## Review focus

1. Simultaneous workers, webhook duplicates, and restart after provider acceptance cannot create a second send.
2. A reply, opt-out, bounce, complaint, pause, or human takeover invalidates queued follow-ups before dispatch.
3. Organization membership, mailbox association, event correlation, and agent actions are checked server-side.
4. Model output and incoming email content are untrusted inputs; they cannot change tool permissions or make unsupported offers.
5. Booking requires a confirmed provider appointment; email interest alone cannot authorize a voice call.

## Wave 1 — Recover a releasable email foundation

Files: retained app routes/libraries, schema-backed database contracts, Next/Sentry config, and corresponding tests. Preserve new Winnr files.

- [x] Recover exact repository and verify real account/schema baseline.
- [x] Implement and locally test Winnr connection, infrastructure display, warm-up controls and unknown-outcome holds.
- [x] Verify Winnr account with read-only requests; store token in Keychain.
- [x] Decide retained product surfaces from actual dependency closure; retire superseded implementations with explicit replacements. Candidate implementation in the recovery worker; no database rows are deleted.
- [x] Reconcile retained schema/query contracts and clear full typecheck/build.
- [x] Verify signup/membership provisioning and tenant isolation against disposable PostgreSQL.

## Wave 2 — Durable channel-independent event spine

Files: `supabase/migrations/021_outreach_event_spine.sql`, `src/lib/outreach/events.ts`, `src/lib/outreach/event-database.ts`, `tests/unit/lib/outreach-events.test.ts`, `tests/integration/outreach-events.test.ts`.

Interfaces: append a validated version-1 canonical event with organization, source, source event ID, correlation, optional subject IDs, and JSON payload; atomically insert named outbox consumers. Unique `(organization_id, source, source_event_id)` deduplicates ingestion; conflicting payload reuse is rejected. Consumers claim with a lease and fencing token, acknowledge only their live claim, and may mark unknown to prevent automatic re-execution of external effects.

- [x] Failing tests for dedupe/conflict, tenant boundaries, competing claims, lease expiry, stale acknowledgements and unknown holds.
- [x] Implement service-only tables/RPCs with RLS, minimal ACLs, transactional append and atomic claims.
- [x] Add typed repository/service using strict input/output validation and injected clients for tests.
- [x] Run real PostgreSQL tests and independent review before integration.

## Wave 3 — Sending and reply loop

Files: retained campaign actions/sequence APIs, new outreach execution service/database migration, Winnr transport and webhook routes, inbox APIs/UI, integration tests.

- [x] Consolidate onto one send ledger and atomic eligibility/claim path; remove legacy bypass entry points.
- [x] Preserve timezone windows, mailbox/provider caps, suppression, reply stops, campaign pause and tenant checks at dispatch.
- [x] Render reviewed copy with sender identity and unsubscribe support; block unresolved fields.
- [x] Reserve before sending, persist provider receipt, advance sequence only after confirmed acceptance, hold ambiguous results.
- [x] Ingest signed Winnr events, dedupe and map messages/threads; stop follow-ups before downstream agent processing.
- [x] Verify controlled SMTP/mail-sink send, receipt, reply, stop, opt-out and crash recovery end to end.

## Wave 4 — Copy and conversation agents

Files: `src/lib/outreach/agents/**`, agent policy/configuration storage, campaign editor/inbox controls, model fixture tests.

- [x] Offer brief: audience, problem, offer, evidence, sender identity, tone, CTA, exclusions and approved claims.
- [x] Copy drafts/variants reference supplied evidence; deterministic validation rejects fabricated proof, unsupported guarantees, unresolved variables and missing required identity/opt-out content.
- [x] Classify replies into interested, objection, not-now, wrong person, opt-out, hostile and uncertain, with confidence and reason.
- [x] Persist decision/model/prompt version and action trace. Escalate low-confidence or sensitive decisions. Human takeover and kill switch cancel pending actions.
- [x] Permit autonomous replies only within a configured approved policy; adversarial inbound-content tests prove tool boundaries.

## Wave 5 — CRM, qualification, booking and voice

Files: provider-specific adapters and authenticated webhooks, organization-scoped configuration, event consumers and contract tests.

- [x] GHL contacts/opportunities with durable effect records; canonical email conversation history stays in ColdForge.
- [x] CloseBot qualification flow follows approved offer/FAQ and real GHL calendar availability; propagate booking/cancellation/reschedule receipts.
- [x] Retell callback adapter with explicit eligibility, time windows, signed event verification and dedupe; attach transcript/summary to the same lead.
- [x] Test CRM, calendar and callback tools with fixtures and actual PostgreSQL orchestration.
- [ ] Run one explicitly selected end-to-end live test using configured accounts and test recipients.

## Wave 6 — Release and operate

- [x] Full lint, strict typecheck, tests and production build pass on the integrated state.
- [x] Review migration, backup/rollback and production configuration as a concrete artifact; do not run the conflicting historical migration set blindly.
- [ ] Open PR and land through required CI. Report branch/worktree and exact live routes separately from local verification.
- [ ] Configure sender domain/mailboxes, verify DNS/warm-up/readiness, launch a controlled pilot with real receipts and volume caps.
- [ ] Monitor delivery/bounces/replies/bookings, surface unknown outcomes and provider outages, and retain an operational kill switch.

## Worker budget and integration order

Four slots total including the driver. Prefer one `deepseek-direct` worker (`deepseek-official` / `deepseek-flash`, served model unattested absent metadata); use native Codex for independent architecture/review or an unavailable/unsuitable route. Separate writer worktrees and file ownership. Record successful and failed attempts. Foundation recovery and event spine can proceed independently; sending consumes both; agents consume sending/events; CRM/voice consume those verified contracts.

## Verified pre-cutover checkpoint — 2026-10-06

The complete integrated candidate passes **970 unit tests in90 files** and
**325 integration tests in19 files**. All16 required PostgreSQL suites ran with
no skipped assertions. Full strict TypeScript, route generation, production
build and lint pass; lint retains25 warnings and zero errors.

Independent module and operator reviews are closed. The final downstream flow
uses actual RPCs and production orchestration to prove contact creation,
current qualification, opportunity creation and approved CloseBot forwarding
across successive ticks. Booking/callback tests preserve one-use grants,
current eligibility, cancellation receipts and unknown-outcome holds. A15-check
desktop/mobile browser fixture passes without overflow or console errors.

The four local TLS/Nodemailer+PostgreSQL mail-loop scenarios are included in the
325 integration cases; they do not prove public mailbox delivery. Focused suite
counts overlap and must not be added to the full-run totals.

A private public-schema/data backup restored locally preserves all14 original
tables and4 existing rows through additive020–033. Managed auth dependencies
use existing primary keys only; this is not a full auth disaster-recovery proof.
The production server is PostgreSQL17.6; local tests run17.9.

This checkpoint precedes production migrations and deployment. A dedicated
Vercel project, required production environment and confirmation redirect origin
are configured. Remote CI, landing and cutover receipts belong in the release PR.
The last read-only database check found one organization, one user, two campaigns,
zero leads, zero email accounts and zero sent emails. The Winnr token is saved
privately; domains and mailboxes still require account configuration.

## Inputs for activation

- Select the sending domain and number of mailboxes; do not infer a purchase.
- Supply the real offer/evidence and selected campaign/test audience.
- Configure app model, validation, CRM/calendar and voice accounts as needed.
- Verify provider callbacks, public delivery and appointment/call receipts with
  selected test contacts before increasing volume.

LinkedIn and social remain future adapters over the shared lead, preference,
event and conversation contracts. They are not represented as connected features.
