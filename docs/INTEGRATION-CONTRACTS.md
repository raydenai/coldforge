# Integration Contracts and Acceptance Tests

## Common adapter behavior

Every provider adapter must expose:

- typed configuration and capability discovery;
- `testConnection` with no mutation;
- timeouts and bounded retry with jitter;
- explicit retryable/non-retryable/rate-limited/auth errors;
- correlation and idempotency keys where supported;
- cursor pagination and rate-limit metadata;
- redacted structured logs;
- sandbox or fixture-backed contract tests;
- reconciliation for accepted-but-not-confirmed operations.

## Winnr acceptance

- Provision/connect one test domain and observe terminal state.
- Create three test mailboxes and retrieve connection metadata securely.
- Enable/pause/resume warming and retrieve health metrics.
- Send a controlled message and preserve provider/message IDs.
- Receive or retrieve a reply and reconstruct the thread.
- Simulate 401, 404, 409, 429, timeout, partial bulk failure, and delayed job completion.
- Replaying any command or event must not duplicate domains, mailboxes, or sends.

## GHL acceptance

- Install/authenticate one test sub-account with least-privilege scopes.
- Upsert the same contact repeatedly without duplication.
- Create/update an opportunity and reconcile external changes.
- Read free slots and create/reschedule/cancel a test appointment idempotently.
- Verify `X-GHL-Signature` Ed25519 callbacks and reject replay/invalid/unsigned payloads.
- Add an inbound email/custom message with stable external IDs.
- Receive a provider outbound message and deliver it through the test email path.

## CloseBot acceptance

- Route an inbound custom/GHL message to the correct tenant and job-flow version.
- Classify positive, objection, not-now, wrong-person, hostile, ambiguous, and opt-out replies.
- Book only after qualification and only into real returned availability.
- Escalate low-confidence, pricing, legal, complaint, and unsupported questions.
- Prevent repeated or contradictory messages after booking or human takeover.
- Preserve conversation and tool-call audit data without unnecessary PII duplication.

## Retell acceptance

- Reject call initiation without positive channel eligibility.
- Create test calls only to approved test numbers.
- Verify `x-retell-signature`; deduplicate call events.
- Process started, ended, analyzed, transcript, transfer, and failure events.
- Booking tools are idempotent and never invent availability.
- Call result updates GHL and Upmax once, even with webhook retries.
- Prompt-injection test calls cannot invoke unauthorized tools.

## Apollo and ZeroBounce acceptance

- Record source, request version, cost/credits, timestamp, and raw-result reference.
- Apollo search does not imply a verified or contactable email.
- ZeroBounce policy separately handles valid, invalid, catch-all, unknown, spamtrap, abuse, and do-not-mail.
- Invalid/high-risk results cannot enter a sendable campaign without an explicit policy exception.
- Bulk partial failures resume without double charging or duplicate records where provider behavior allows.

## Smartlead parity harness

Document and test the Upmax equivalents of:

- campaign and sequence creation;
- lead import/dedupe/unsubscribe;
- account rotation/capacity;
- send/open/click/reply/bounce/unsubscribe events;
- pause/resume/cancel;
- unified reply handling;
- analytics and webhooks.

Smartlead is evidence for expected operator capability, not the Upmax system of record.
