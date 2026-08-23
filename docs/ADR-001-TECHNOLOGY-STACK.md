# ADR-001: Technology Stack and Language Boundaries

- Status: Accepted
- Date: 2026-08-22
- Owners: Queen CTO and human product owner

## Context

ColdForge is already a large Next.js/TypeScript application with Supabase, Redis/BullMQ, Stripe, email, CRM, and AI integrations. The immediate business objective is a production replacement for Mailscale and Instantly, followed by an appointment-focused multi-channel system.

Rust and Go can outperform Node.js in selected workloads, but a full rewrite would discard existing UI/domain work, delay provider integration, multiply deployment surfaces, and introduce cross-language consistency risk before the product loop is proven.

## Decision

### Product and control plane

Use:

- TypeScript in strict mode;
- Node.js 24 LTS, pinned to an exact tested patch in CI and containers;
- Next.js 16 for the web application and API boundary;
- Postgres/Supabase as durable system of record;
- Redis/BullMQ for Release A background execution, backed by a Postgres event inbox/outbox for durability;
- Zod at runtime trust boundaries;
- OpenTelemetry-compatible tracing, structured logs, and Sentry.

Organize this as a modular monolith with enforceable bounded-context dependencies. UI and API code may deploy together; workers run as separate Node processes/containers but share the TypeScript domain packages.

### Go extraction target

Go is the preferred language for a new independently deployable service when at least one condition is demonstrated under representative load:

- a Node worker cannot meet an approved p95 latency or event-lag SLO after profiling and bounded optimization;
- sustained CPU or memory cost is at least 2x the approved budget;
- connection/concurrency requirements create operational instability;
- a single static operational binary materially reduces deployment risk;
- isolating the workload reduces blast radius enough to justify distributed-system cost.

Likely candidates are webhook ingestion, provider reconciliation, high-volume inbox synchronization, event replay, or an operations CLI. Start with Go 1.26.7; evaluate Go 1.27 after dependency compatibility and an initial production soak.

### Rust exception path

Rust requires an ADR with benchmarks and security analysis. Appropriate candidates are:

- untrusted MIME/content parsing at extreme volume;
- cryptographic or signature-verification components not adequately served by maintained libraries;
- CPU-heavy scoring/transformation;
- memory-sensitive long-running components where Go/Node fail the budget.

Rust is not the default API, worker, or integration language. Its compile-time memory/concurrency guarantees do not solve idempotency, retries, consent, authorization, or distributed transactions.

## Contract rules

- Cross-process contracts use versioned OpenAPI, AsyncAPI, Protobuf, or JSON Schema.
- Generate clients and fixtures; never manually duplicate DTOs.
- Every schema change has backward/forward compatibility tests.
- Services do not share database tables as an informal API. Ownership is explicit.
- External provider DTOs remain inside adapters.
- Trace, tenant, correlation, causation, and idempotency IDs cross every boundary.

## Prohibited choices

- No full rewrite for language preference.
- No microservice without measurable benefit and an owner/runbook.
- No serverless fan-out for durable sequencing unless delivery, ordering, replay, and cost are proven.
- No new queue/event broker during Release A unless the current design cannot satisfy a demonstrated gate.
- No FFI/native addon in the web process without a security and deployment case.

## Consequences

Benefits:

- shortest path to a working product;
- one type system across UI, API, workers, and vendor SDKs;
- simple local development and agent parallelization;
- preserves an evidence-based path to Go/Rust where they are superior.

Costs:

- Node workers require careful backpressure and memory monitoring;
- eventual Go/Rust extraction adds contract and operational overhead;
- modular boundaries must be actively enforced to avoid a monolith becoming tangled.

## Validation

The Queen reviews this ADR after the Release A staging load test and again after the first production pilot. Any proposed extraction must include before/after benchmarks, operational cost, migration sequence, fallback, and proof that the TypeScript path remains compatible during transition.
