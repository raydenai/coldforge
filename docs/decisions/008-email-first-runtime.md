# 008 — Email-first runtime and canonical storage

Accepted 2026-10-05 by the accountable driver following the user's Winnr-first product direction.

ColdForge retains the complete outreach northstar: cold email is the first module; social outreach and agents for copy, replies, GHL, CloseBot, and Retell follow behind explicit contracts. This change recovers the email workspace without claiming that durable sending or ingestion is already delivered.

## Runtime boundary

Winnr owns mailbox connections, domain/provider reads, and warming. `/accounts`, `/domains`, and `/warmup` remain bookmark-compatible redirects to `/winnr`. Navigation links directly to Winnr. Local SMTP/OAuth provisioning, fabricated warmup engagement, old sending queues/process endpoints, legacy tracking endpoints, agencies/white-label, legacy billing/API-key settings, and unsupported integration/scale runtime surfaces are retired from source and routing. Git retains their history; historical SQL migrations and documentation are preserved. Obsolete cron schedules are removed rather than pointed at nonexistent handlers.

Retained user journey: signup/login → transactional organization onboarding → Winnr connection → leads/list import → campaign configuration, sequences, and enrollment → existing saved inbox conversations. Campaign APIs/UI and Winnr are maintained by their separate implementation shards. Canonical inbox reads use `threads`, `thread_messages`, and `replies`, without inventing a local `mailboxes` relation. A retired mailbox UUID does not establish a Winnr provider identity; thread detail returns `mailbox: null` until a genuine mapping is recorded.

Manual replies, mailbox sync, and the legacy receive POST explicitly return authenticated same-origin `409 transport_not_configured`. The reply composer explains the disabled transport. Campaign start/resume similarly remains blocked until the durable sender is integrated. Historical claim/dispatched/release helpers fail closed and do not call nonexistent RPCs. These are tracked missing requirements, not successful no-op operations.

## Storage and data preservation

`src/types/database.ts` is the parent-verified read-only public schema snapshot: fourteen existing tables, not the obsolete handwritten 98-table model. No typechecker exclusions, permissive casts, suppression directives, or compiler settings were introduced to hide missing storage. New contracts declare narrow types tied to tested additive migrations: Winnr020, events021, campaigns022, suppression023, identity025. Dispatch024 is reserved by the driver; the next transport shard is separately owned.

Existing live tables and rows are not deleted, renamed, or reset. Only explicitly guarded disposable local fixtures are reset during tests. Service storage refuses an absent service-role credential instead of falling back to anonymous access. Dashboard metrics count tenant-owned saved rows, distinguish unavailable from measured zero, and direct provider measurements to Winnr.

Migration023 introduces organization-scoped suppression with normalized lower/trim email keys, bounded metadata, browser-denied reads/writes/RPC, and a service-only transaction. Signed opt-out resolves a lead within the signed organization and atomically records suppression, stops matching organization leads, and clears campaign enrollment scheduling through organization-owned joins. Replays are idempotent and cannot downgrade complaint/unusable-address suppression. No browser unsuppress API exists. This lookup is not an atomic send authorization; final dispatch remains a separate required contract.

Live metadata showed no installed auth signup trigger. Migration025 provides a service-only bootstrap called using the server-verified cookie user ID. The RPC locks the existing auth identity, reads its stable email, uses metadata only for bounded display text, preserves existing organization/role, and creates one organization and owner membership for an unjoined user. Request bodies cannot select a user, existing organization, or role. Concurrent bootstraps are idempotent; installation of020 membership protections is a prerequisite.

Legacy user audit calls append version1 events to the canonical event service with zero consumers. Arbitrary details, request bodies, credentials, and network metadata are omitted. Events without an organization are not represented as tenant events; asynchronous persistence failures are logged, not claimed as durable success.

## Verification and next gate

Suppression and identity PostgreSQL suites use separate guarded fixtures on localhost port55439: `SUPPRESSION_TEST_DATABASE_URL` → `coldforge_suppression_test`; `IDENTITY_TEST_DATABASE_URL` → `coldforge_identity_test`. They can run with standard Vitest file parallelism. No production migration was applied and no provider was called.

The driver must compose the campaign and final event candidates, run the complete compiler/test/lint/build gates, review migration installation and environment configuration, then finish the durable send and ingestion requirements before claiming a release-ready outreach app. The old production plan is historical evidence, not the current runtime contract.
