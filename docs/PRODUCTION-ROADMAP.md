# Production Roadmap

Durations are wall-clock estimates with four bounded writing sidecars, not guarantees. External approvals and production evidence can extend them.

## Wave 0 — Foundation and truth (Days 1–5)

Outcome: `main` becomes an honest, reproducible development baseline.

- Fix install/postinstall portability.
- Pin Node.js 24 LTS in local, CI, and deployment environments; validate the upgrade from the current Node 22 baseline.
- Resolve all failing tests and error-contract drift.
- Reduce lint to zero errors and an owned warning budget, then to zero warnings.
- Diagnose and fix the TypeScript `Map maximum size exceeded` failure.
- Produce a green Next.js production build.
- Add `typecheck`, integration, E2E, and release-gate scripts.
- Add GitHub CI with install, lint, typecheck, unit, integration, build, and dependency checks.
- Replace the default README; generate and validate a complete environment schema.
- Remove stale Next.js configuration and deployment drift.
- Make webhook verification fail closed; fix the missing unsubscribe route and single-step opt-out.
- Inventory placeholders and prohibit them on Release A paths.

Exit: a clean checkout passes all local and CI foundation gates.

## Wave 1 — Event and provider spine (Days 4–12)

Outcome: all vendor interactions use stable contracts and a reliable event ledger.

- Define canonical IDs, events, provider ports, error taxonomy, and idempotency rules.
- Add inbound event receipts, transactional outbox, dead-letter queue, replay, and reconciliation.
- Implement Winnr client: account, domains, mailboxes, warming, inbox, sending/credentials, jobs.
- Implement strict webhook/request fixtures and sandbox contract tests.
- Implement GHL OAuth/private integration adapter, token storage/refresh, contact/opportunity/calendar clients.
- Implement GHL Ed25519 webhook verification and provider-delivery endpoint.
- Add provider health, rate-limit, retry, timeout, circuit, and audit metrics.

Exit: synthetic and sandbox provider flows pass contract and failure tests without production credentials.

## Wave 2 — Native email execution (Days 8–20)

Outcome: Upmax safely executes a real campaign through Winnr in a staging environment.

- Replace competing send paths with one campaign state machine.
- Add lead CSV import, mapping, dedupe, provenance, and ZeroBounce validation.
- Add Apollo behind a lead-source adapter; keep CSV/GHL import available.
- Implement approvals, templates, variables, spintax, variants, schedules, timezone and capacity rules.
- Perform an atomic final eligibility/suppression check immediately before send.
- Add RFC-compliant identity and unsubscribe headers/body/footer.
- Implement delivery, reply, bounce, complaint, and opt-out event transitions.
- Stop future steps on reply/booking/suppression; test races and duplicate events.
- Add infrastructure health quarantine and safe reassignment.
- Replace mock-only integration tests with disposable Supabase/Redis and a controlled mail sink/provider sandbox.

Exit: a staging campaign completes end-to-end with zero duplicate sends and correct stop behavior.

## Wave 3 — Reply-to-appointment loop (Days 15–28)

Outcome: a positive cold-email reply becomes a qualified GHL appointment.

- Build unified thread/reply normalization and intent classification with confidence.
- Create/update GHL contacts and opportunities with deterministic field mapping.
- Register the Upmax custom email conversation provider in GHL.
- Post Winnr replies into GHL with thread and external message IDs.
- Receive signed GHL outbound-provider events and reply through Winnr.
- Configure CloseBot source/job flow, knowledge, qualification, escalation, and booking mapping.
- Synchronize GHL appointment create/update/delete events back to Upmax.
- Stop sequences on booking; add confirmations, rescheduling, cancellation, and closer context.
- Add human escalation for pricing, legal, hostile, ambiguous, complaint, and low-confidence replies.

Exit: controlled positive, negative, objection, opt-out, and booking scenarios pass E2E tests.

## Release A pilot gate (Days 25–35)

- Security/threat-model review and tenant-isolation tests.
- Migration rehearsal, backup restore, deploy and rollback drills.
- Load, queue recovery, provider outage, replay, and rate-limit tests.
- Observability dashboards, alerts, runbooks, and incident ownership.
- Small internal pilot with seed/test recipients, followed by an explicitly approved limited live cohort.
- Compare results and workflow parity against existing Instantly/Mailscale operation.

Exit: owner-approved production pilot; no automatic broad rollout.

## Wave 4 — Upmax revenue automation (Weeks 6–9)

- Retell integration for inbound, requested callbacks, appointment confirmation, and compliant no-show recovery.
- Call transcript/analysis ingestion, QA, disposition, and GHL timeline updates.
- Permissioned SMS/WhatsApp follow-up through GHL.
- Lead scoring, segment-specific sequences, reply-response SLA automation.
- No-show, nurture, closed-lost, and reactivation workflows.
- Operator funnels and cost/revenue attribution.
- Client workspaces, quotas, billing, audit exports, and controlled white-labeling.
- Profile event lag, memory, CPU, queue depth, and deployment coupling. Extract a Go worker only if ADR-001 thresholds are met.

## Wave 5 — Multi-channel expansion (Weeks 9–12+)

- Retargeting audience synchronization after privacy/platform review.
- Social DM adapters only through approved APIs and account policies.
- Cross-channel frequency and attribution engine.
- Experiment governance and automatic winner promotion within safe bounds.
- Additional infrastructure, CRM, data, validation, text-agent, and voice providers.
