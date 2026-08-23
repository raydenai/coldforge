# Goals, SLOs, and Evidence

## Goal hierarchy

### G0 — Trustworthy production foundation

- Reproducible install and deployment.
- Green lint, typecheck, tests, and production build.
- Real disposable-service integration tests.
- Verified tenant isolation, secret handling, webhook security, and rollback.

### G1 — Replace Mailscale

- Provision or connect Winnr domains and mailboxes.
- Surface DNS/authentication, warming, capacity, and health.
- Quarantine unhealthy infrastructure automatically.

### G2 — Replace Instantly

- Import/validate leads and run multi-step sequences.
- Rotate healthy mailboxes within policy and capacity.
- Handle replies, bounces, complaints, and opt-outs correctly.
- Provide inbox, analytics, pausing, recovery, and campaign controls.

### G3 — Book appointments

- Synchronize interested replies into GHL.
- Let CloseBot qualify and book against live GHL calendars.
- Stop sequences and update opportunities immediately after booking.
- Provide full context and attribution to the closer.

### G4 — Expand into Upmax multi-channel

- Add permissioned SMS and voice.
- Add reminders, no-show recovery, reactivation, and inbound call handling.
- Add scoring, enrichment, experimentation, and client workspaces.

## Release A service objectives

| Measure | Target |
|---|---:|
| Duplicate sends | 0 |
| Sends after suppression/opt-out is committed | 0 |
| Valid provider event processing | 99.9% within 60 seconds |
| Positive reply visible in GHL | p95 under 60 seconds |
| Booking reflected in Upmax | p95 under 60 seconds |
| Webhook acknowledgement | p95 under 2 seconds |
| Cross-tenant data exposure | 0 |
| Secrets/PII in logs | 0 |
| Queue recovery point | No acknowledged event loss |
| Production rollback | Under 15 minutes for application release |

## Funnel metrics

Track by tenant, campaign, segment, copy version, mailbox cohort, and time window:

- leads sourced, enriched, validated, eligible;
- attempted, accepted, delivered, bounced, complained, opted out;
- replies and classified intent;
- qualified conversations;
- booking offers, bookings, reschedules, cancellations;
- attended, no-show, opportunity value, won revenue;
- time to first touch, reply-response SLA, time to booking;
- cost per valid lead, positive reply, booking, attended booking, and win.

Open and click rates are diagnostic signals, not the north star.

## Readiness scoring

The Queen updates these categories from 0–5 with linked evidence:

1. build and developer experience;
2. correctness and test depth;
3. security and tenant isolation;
4. compliance and suppression;
5. provider integration reliability;
6. observability and operations;
7. user workflow completeness;
8. recovery and rollback.

Release A requires every category at least 4 and no unresolved P0/P1 issue.
