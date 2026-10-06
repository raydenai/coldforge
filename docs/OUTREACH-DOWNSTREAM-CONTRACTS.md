# Downstream outreach contracts (shard 033)

Date: 2026-10-05. Bounded, configured CRM/calendar, CloseBot bridge and
requested Retell callbacks over the reviewed email-first core (020–032).

## Primary sources (public documentation, retrieved 2026-10-05)

| Provider | Source | Contract used |
| --- | --- | --- |
| GHL | https://marketplace.gohighlevel.com/docs/ghl/contacts/upsert-contact/index.html | `POST /contacts/upsert` (v3), bearer token, `Version: v3`; body requires `locationId`; response `{ new, contact, traceId }` |
| GHL | https://marketplace.gohighlevel.com/docs/ghl/opportunities/upsert-opportunity/index.html | `POST /opportunities/upsert` |
| GHL | https://marketplace.gohighlevel.com/docs/ghl/calendars/get-slots/index.html | `GET /calendars/:calendarId/free-slots` with `startDate`/`endDate` epoch ms, `timezone`, response availability map keyed by `YYYY-MM-DD` with `slots` |
| GHL | https://marketplace.gohighlevel.com/docs/ghl/calendars/get-calendar/index.html | `GET /calendars/:calendarId` (v3); returns `slotDuration`/`slotDurationUnit`/`durationOptions` |
| GHL | https://marketplace.gohighlevel.com/docs/ghl/calendars/create-appointment/index.html | `POST /calendars/events/appointments` (v3); `startTime` required, `endTime` optional |
| GHL | https://marketplace.gohighlevel.com/docs/ghl/calendars/edit-appointment/index.html | `PUT /calendars/events/appointments/:appointmentId` reschedule |
| GHL | https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide/index.html | `X-GHL-Signature` = base64 Ed25519 over the raw UTF-8 body, verified with the official published PEM; legacy `X-WH-Signature` RSA is not accepted |
| CloseBot | https://developers.closebot.com/api-reference/webhook/send-a-webhook-event.md | base `https://api.closebot.com`, header `X-CB-KEY`, `POST /webhook/event/{sourceId}` |
| CloseBot | https://docs.closebot.com/en/articles/16358483-custom-blank-source-channel-webhook | custom blank source "Catch" endpoint receives message-received events; optional access-token requirement |
| Retell | https://docs.retellai.com/api-references/create-phone-call.md | base `https://api.retellai.com`, `POST /v2/create-phone-call`, bearer key, `idempotency_key` valid 1 hour, `from_number`/`to_number` E.164; response contains `call_id` |
| Retell | https://docs.retellai.com/api-references/list-phone-numbers.md | `GET /v2/list-phone-numbers` bearer, paginated `{ items, has_more, pagination_key }`, `limit` max 1000; items expose `outbound_agents` |
| Retell | https://docs.retellai.com/api-references/get-phone-number.md | `GET /get-phone-number/{phone_number}` exact single probe |
| Retell | https://docs.retellai.com/features/secure-webhook.md | `X-Retell-Signature: v=<ms>,d=<hex>`; `HMAC-SHA256(raw_body + timestamp, api_key)`; 5-minute freshness; constant-time compare |

No provider account endpoint or credential was contacted; only public
documentation was retrieved. API versions are recorded as observed on the date
above and are re-verified when a live pilot is configured.

## Trust boundaries and invariants

1. **Credentials are private and org-scoped.** Each provider has one
   `outreach_provider_connections` row per organization. The credential is
   AES-256-GCM encrypted by the server (`src/lib/encryption.ts`) before storage.
   The browser-facing `read` RPC returns only presence metadata
   (`configured`, `revision`, `enabled`, `capability`, check timestamps) and
   never the ciphertext. Every mutation is revision-checked (compare-and-swap).
2. **Disabled by default. Saved config is not a verified connection.** A new
   connection has `enabled=false`. Only a server-run, read-only capability
   check sets `verified_at`; changing configuration clears it. `enabled` does
   not imply `verified`.
3. **Untrusted content cannot choose the tenant or action.** The provider,
   target organization, connection revision and effect kind are resolved
   server-side. Inbound text, model output and provider callbacks can only
   produce records (proposal/qualification) and can never send email, select a
   recipient or authorize a call.
4. **Reserve before every non-idempotent provider call.** `outreach_downstream_effects`
   has a stable `logical_key` (`decision:<decisionId>:<effectKind>`) that is
   independent of any browser UUID or config version. The unique insert is the
   only way an effect becomes executable; a concurrent duplicate or a replay
   gets `effect_exists` and no second call is made.
5. **Uncertain outcomes are held, never retried.** A timeout, an uncertain
   provider body or a failed receipt persist marks the effect/callback
   `unknown`; `nextReservedEffect` only returns `reserved` rows, so an unknown
   effect is never automatically re-executed and no new UUID can bypass it.
6. **One external write per tick, absolute deadline.** `runDownstreamTick`
   either settles exactly one reserved effect (one provider call) or claims one
   canonical decision job and reserves its effects without a provider call.
   Provider calls are bounded by the request deadline (and a fixed 12s cap) and
   the complete response body is byte-bounded and abort-raced against the same deadline; a redirect fails closed (`redirect:
   'error'`).
7. **No email is sent here.** The only email path remains the 029 prepared
   shared gate. A CloseBot proposal is stored as a record and cannot send; any
   freeform external message requires explicit operator approval and the 030
   approved-FAQ/current-control policy is untouched. The native 030 approved-FAQ
   automation continues to work when CloseBot is not configured.
8. **Qualification and booking are explicit.** An opportunity is only synced
   after an `outreach_qualifications` row with `outcome='qualified'` exists. A
   CloseBot callback only records a qualification when it carries an explicit
   `criteriaRevision`, `criteria`, `outcome` and `evidence`. Email "interested"
   classification alone never qualifies.
9. **Callbacks need owner-recorded eligibility.** `outreach_callback_eligibility`
   is written only by an owner/admin (`recordEligibility`) with an explicit
   consent basis, evidence, E.164 number, IANA timezone, local window, expiry
   and call cap. The final grant re-checks the current phone, the unrevoked
   state, the cap, the local window and the current master stop
   (`outreach_operations_outbound_stopped`). Retell initiation reserves a
   callback first and persists the real `call_id`; a timeout holds it unknown.
10. **Canonical event consumer.** The scheduler consumes the exact 021 outbox
    consumer `outreach.conversation.decision` emitted by 030. It does not
    re-implement or double-integrate the 029/030 send loops. The cron uses the
    same constant-time `CRON_SECRET` pattern and a fair, current-owner
    organization selection RPC.

## Implemented capability vs. honest gaps

| Capability | State |
| --- | --- |
| GHL contact upsert, CRM link persistence | Implemented (adapter + effect + RPC) |
| GHL opportunity upsert | Implemented, gated on an explicit qualification record |
| GHL calendars list / get-calendar duration | Implemented; `slotDuration`/`durationOptions` parsed, never defaulted |
| GHL free slots | Implemented; only provider-returned starts are surfaced (`endAt` null, never synthesized) |
| GHL appointment create | Implemented; re-checks the current free slot, sends `startTime` only when the verified duration is unknown |
| GHL appointment reschedule/cancel | Implemented via `PUT`/`DELETE` with the same durable effect + unknown hold semantics |
| Operator availability → slot → reserve → one write → receipt | Wired end to end through the API and pipeline UI |
| CloseBot outbound event forward | Implemented for approved decisions with a ready canonical body |
| CloseBot inbound callback token + dedupe + proposal/qualification | Implemented; the token is encrypted credential material, never plain config |
| CloseBot operator queue + human takeover | Implemented; review records the decision and hands off to the shared 029 inbox, never auto-sends |
| Qualification criteria/evidence/outcome form | Implemented (API + pipeline UI) |
| Retell `create-phone-call` with idempotency key and call-id persistence | Implemented |
| Retell signed webhook, call status/summary | Implemented |
| Retell read-only capability probe | Implemented against `list-phone-numbers`/`get-phone-number`; verifies the configured `fromNumber` and its outbound agent with bounded pagination |
| GHL webhook signature | Implemented as base64 Ed25519 over the raw UTF-8 body with the official published PEM; no arbitrary tenant key and no legacy RSA |
| GHL booking webhook matching | Implemented; a booking changes only on a matching immutable location + provider appointment id, otherwise recorded as unmatched |

## Unresolved provider contracts (reported, not invented)

- **GHL authorization/version:** confirmed `Version: v3` and `services.leadconnectorhq.com` from the public pages. The `2021-07-28` header variant is explicitly not used.
- **CloseBot inbound token header:** configuration accepts `inboundTokenHeader` (default `x-closebot-token`); confirm the exact header against a live captured event before enabling the bridge.
- **Live pilot:** no provider account or credential was contacted; every adapter contract above is from public documentation and is re-verified when a live pilot is configured. The official GHL Ed25519 PEM is used verbatim from the integration guide.

## Exact-version safety (independent review fixes)

- `effectContext` reads `winnr_ingested_messages.received_at` (027), fixing the worker-context failure.
- The effect logical key is the canonical operation (`sourceReplyId` + kind), so a re-decision/config change cannot reserve a second effect while the first is unknown.
- `claimEffect` takes an exclusive row lock and writes a dispatch fence token; an expired lease becomes a durable `unknown` hold and is never automatically re-executed.
- `settleEffect` requires the fenced dispatch token and `dispatching` state; a stale/duplicate worker settles nothing.
- The grant re-checks the exact reserved connection revision, the current master stop and the approved canonical decision; a mismatch refuses handoff and holds the reservation. No provider effect is claimed from that refusal.
- A configured-but-disabled provider keeps the approved decision outbox un-acked (retryable hold) instead of dropping the operation.

## Test evidence

- `tests/unit/lib/outreach-downstream.test.ts` — signature verification (base64 Ed25519 only), fixed origins, redirect/byte bounds, response-only slots, calendar duration parsing, optional `endTime`, reschedule PUT, Retell bounded pagination/single probe, credential encryption/redaction/blank-keep, slot re-check, one-write booking.
- `tests/unit/components/outreach-pipeline.test.tsx` — presence-only rendering, failed-load alert, disabled-until-ready booking, truthful `held (unknown)` label.
- `tests/integration/outreach-downstream.test.ts` — real PostgreSQL, actual migrations 020–033 over the committed baseline: presence-only read, CAS, reserve-once, unknown hold, exclusive fenced claim + stale-token refusal, canonical key across re-decisions, stale revision at the grant, qualification gate, approved-decision forward, owner-only eligibility/review, phone/master-stop/cap gating, appointment reserve/settle, GHL webhook location+provider binding, cross-tenant refusal, current-owner selection.

## CloseBot capability & wizard setup (official contracts)

1. In CloseBot create a **custom blank source channel** ("Catch") per
   `docs.closebot.com/en/articles/16358483-custom-blank-source-channel-webhook`;
   copy its **source id** into `config.sourceId`.
2. Set the outbound API key (`X-CB-KEY`) as the connection credential and the
   **inbound callback token** as a separate credential field. The inbound token
   is stored only as encrypted credential material; it is never written to
   plaintext config and never returned to the browser.
3. Point the CloseBot inbound webhook at
   `POST /api/webhooks/downstream/{organizationId}/closebot` and send the token
   in the configured header (default `x-closebot-token`; override with
   `config.inboundTokenHeader`).
4. CloseBot is a **custom source**: the forward is a configured explicit action
   (`config.sourceId` + the connection `enabled` flag). Automatic forwarding is
   off unless the provider is configured, enabled and the canonical decision is
   approved. A proposal received back is recorded in the operator queue and
   requires human review or takeover; the module never auto-replies.
5. A CloseBot classification is **not** consent, a booking or a qualification.
   A qualification row requires an explicit `criteriaRevision`, `criteria`,
   `outcome` and `evidence` written by an owner/admin or a callback that carries
   those fields, and email interest alone never authorizes a call.

## Retell read-only probe

`GET /v2/list-phone-numbers` (bearer) is paged with `limit=100` for at most five
pages and stops at `has_more=false`; the configured `fromNumber` must appear and
its `outbound_agents` binding is reported. `GET /get-phone-number/{phone_number}` provides
an exact single-number probe. A missing capability or a number that is not
found is reported honestly and never marked verified; no paid call is made to
probe.


## Final write linearization (033 closure)

A claimed effect is not authorization to call a provider. `beginWrite` fixes the
actual complete outbound payload and its UTF8 SHA256 in service-only
`outreach_downstream_writes`; `authorizeWrite` spends its token exactly once
immediately before handoff under the same `email-dispatch:<org>` advisory lock
as031 stop and029 human takeover. Reservation-time source snapshots bind owner
membership, provider revisions, canonical lead/body/latest inbound, control and
policy revisions. Callback grants additionally recheck unrevoked consent, exact
current phone, expiry, local window and conservative call cap. Booking create,
reschedule and cancel all use this ledger; an unresolved operation holds every
other mutation for that appointment. New browser/config/decision IDs cannot
release an unknown hold.

Settlement requires the exact write ID, token, fingerprint and subject/kind. A
lost provider response or failed receipt persistence remains unknown; no retry
occurs automatically. Read/RPC expiry after30 seconds makes missing authorized
receipts visible as unknown. Historical preliminary effect fingerprints identify
decision planning; the actual write ledger fingerprint authorizes immutable
provider content.

Authenticated early Retell/GHL webhook payloads persist and replay after exact
provider receipt association; conflicting explicit event identities still fail.
GHL events without a unique provider event ID use the verified raw-body hash,
so a later legitimate update is distinct and an identical delivery deduplicates.
CloseBot Take over changes the canonical029 control to human and invalidates
queued replies; reviewing never sends a message.

Pipeline uses the actual camelCase inbox projection, the displayed current lead
phone for eligibility, explicit ISO UTC expiry from browser local time, and
calendar/date generation fences for slot selection. Provider-side current slot
rechecks remain required.

CloseBot proposal plus optional qualification is recorded in one033 RPC
transaction (`recordQualifiedBridge`); a conflicting source-event retry rolls
back both halves. Optional campaign/thread/decision references are tenant-bound.
Owner/admin HTTP checks occur before privileged repository construction.
