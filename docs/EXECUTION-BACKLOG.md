# Execution Backlog

The Queen converts these epics into small task cards. IDs are stable; dependencies are in parentheses.

## P0 Foundation

- **FND-001** Reproduce and document install/test/lint/type/build baseline.
- **FND-002** Fix nine error-contract test failures. (`FND-001`)
- **FND-003** Resolve all lint errors without weakening rules. (`FND-001`)
- **FND-004** Isolate and fix TypeScript map explosion. (`FND-001`)
- **FND-005** Produce clean Next.js build and remove stale config. (`FND-004`)
- **FND-006** Add complete env schema and startup validation.
- **FND-007** Replace README and developer/bootstrap documentation.
- **FND-008** Add CI and required quality scripts. (`FND-002..006`)
- **FND-009** Add real Supabase/Redis/mail-sink test harness.
- **FND-010** Add structured logging, redaction, trace/correlation IDs.
- **FND-011** Create migration validate/reset/backup/restore workflows.
- **FND-012** Remove or fence production-path placeholders.
- **FND-013** Pin Node.js 24 LTS across version file, CI, containers, and deployment; verify compatibility.

## Architecture and language governance

- **ARC-001** Enforce modular boundaries and dependency rules in the TypeScript control plane.
- **ARC-002** Publish OpenAPI/AsyncAPI/JSON Schema contracts and generated-client workflow.
- **ARC-003** Establish runtime profiling and service-extraction dashboards.
- **ARC-004** Evaluate Go extraction only after an ADR-001 threshold is exceeded.
- **ARC-005** Evaluate Rust only for a measured security/CPU/memory hotspot.
- **ARC-006** Add cross-language contract, compatibility, and deployment tests before any service split.

## P0 Security and compliance

- **SEC-001** Threat model identity, tenants, provider callbacks, queues, and AI tools.
- **SEC-002** Verify all webhook signatures; fail closed on absent secrets.
- **SEC-003** Timestamp/replay protection and event deduplication.
- **SEC-004** Complete single-step unsubscribe endpoint and confirmation UX.
- **SEC-005** Global suppression ledger across tenants/senders according to policy.
- **SEC-006** Atomic pre-send eligibility transaction.
- **SEC-007** Postal identity, accurate headers, List-Unsubscribe and one-click headers.
- **SEC-008** Tenant/RLS integration and negative authorization tests.
- **SEC-009** Secret encryption/rotation and PII log audit.
- **SEC-010** Channel consent, DNC, quiet hours, timezone, and frequency policy engine.
- **SEC-011** AI prompt-injection, tool permission, escalation, and audit controls.

## P1 Event platform

- **EVT-001** Canonical event envelope and version policy.
- **EVT-002** Provider event receipt table with uniqueness.
- **EVT-003** Transactional outbox and workers.
- **EVT-004** Consumer idempotency receipts.
- **EVT-005** DLQ, replay, reconciliation, and operator UI.
- **EVT-006** Event metrics, lag alerts, and trace views.

## P1 Winnr

- **WIN-001** Typed client, auth, timeout, retries, errors, and rate limits.
- **WIN-002** Domain purchase/connect/status adapter.
- **WIN-003** Mailbox create/bulk/status/credentials adapter.
- **WIN-004** Warming enable/settings/metrics adapter.
- **WIN-005** Inbox/thread/message ingestion adapter.
- **WIN-006** Send/SMTP selection and message-ID mapping.
- **WIN-007** Async job polling/reconciliation.
- **WIN-008** Health/capacity cache and automatic quarantine.
- **WIN-009** Contract fixtures and sandbox/live-test-account suite.

## P1 Campaign engine

- **CAM-001** One canonical campaign and lead state machine.
- **CAM-002** Sequence scheduler with timezone/quiet-hour behavior.
- **CAM-003** Capacity-aware healthy mailbox allocator.
- **CAM-004** Deterministic idempotency key for every planned touch.
- **CAM-005** Template/variable/spintax validation and immutable versions.
- **CAM-006** Approval state for audience, copy, schedule, and channel.
- **CAM-007** Final atomic suppression and eligibility gate. (`SEC-005,006`)
- **CAM-008** Reply/bounce/complaint/opt-out/booking stop transitions.
- **CAM-009** Pause/resume/cancel/recovery and reconciliation.
- **CAM-010** Campaign parity E2E suite against documented Smartlead/Instantly behaviors.

## P1 Lead intelligence

- **LEAD-001** CSV import preview, mapping, validation, and error export.
- **LEAD-002** Tenant-aware normalization and deduplication.
- **LEAD-003** Provenance and consent-basis records.
- **LEAD-004** ZeroBounce single/batch adapter and decision policy.
- **LEAD-005** Apollo search/enrichment adapter and cost controls.
- **LEAD-006** ICP/fit score and segment assignment.
- **LEAD-007** GHL contact import and reconciliation.

## P1 GHL and CloseBot booking

- **GHL-001** OAuth/private integration, scoped tokens, encrypted storage, refresh.
- **GHL-002** Contact and custom-field mapping/upsert.
- **GHL-003** Opportunity pipeline/stage mapping.
- **GHL-004** Calendar free-slot and appointment adapter.
- **GHL-005** Ed25519 webhook verification and event ingestion.
- **GHL-006** Upmax custom email conversation provider.
- **GHL-007** Winnr inbound reply -> GHL inbound message bridge.
- **GHL-008** GHL provider outbound -> Winnr reply bridge.
- **GHL-009** Message status and reconciliation.
- **CB-001** CloseBot source/job-flow configuration and version mapping.
- **CB-002** Qualification schema, confidence, objection and escalation paths.
- **CB-003** GHL calendar booking/reschedule/cancel scenarios.
- **CB-004** Knowledge versioning and unanswered-question workflow.
- **CB-005** E2E reply-to-booking scenario suite.

## P2 Retell and revenue automation

- **RET-001** Eligibility gate: inbound/consented/warm/legal-policy-approved only.
- **RET-002** Agent/version/phone/call adapter.
- **RET-003** Signed webhook and call-event ingestion.
- **RET-004** GHL availability/booking tools with idempotency.
- **RET-005** Transcript, analysis, disposition, and GHL timeline sync.
- **RET-006** Test-case/QA suite and human escalation.
- **REV-001** Appointment reminders and confirmation.
- **REV-002** No-show recovery.
- **REV-003** Closed-lost/nurture/reactivation.
- **REV-004** SMS/WhatsApp only through policy-approved GHL workflows.

## P1/P2 Operations and product

- **OPS-001** Sentry/log/metric tracing and redaction.
- **OPS-002** Queue/provider/booking funnel dashboards.
- **OPS-003** Alert policies and incident runbooks.
- **OPS-004** Backup, restore, deploy, rollback, and disaster drills.
- **OPS-005** Provider outage/failover and reconciliation tests.
- **UI-001** Provider onboarding and connection health.
- **UI-002** Lead import/validation workflow.
- **UI-003** Campaign approval and launch workflow.
- **UI-004** Unified inbox, escalation, and AI audit view.
- **UI-005** Pipeline/appointment and attribution dashboard.
- **UI-006** DLQ/replay and operator recovery console.
