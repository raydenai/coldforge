# Outreach execution contract

Date: 2026-10-05. Product decisions under the owner's instruction to build and manage the email-first outreach suite autonomously.

## Shared channel foundation

Winnr is the email infrastructure provider. Campaign sends, manual replies, agent replies, and external CloseBot/GHL replies must use the same durable email effect ledger and SMTP authorization boundary. A new channel may reuse contacts, preferences, event history, decisions and appointments; it must not silently inherit email permission.

One send reservation fixes the recipient, sender, body, thread context, and message ID. The final authorization checks current policy and stop conditions. An ambiguous handoff stays held; an operator cannot bypass that hold by generating another operation ID. A reconciliation action may mark it accepted only from an account-bound Winnr relay receipt that exactly matches the frozen message ID, sender and recipient. Reconciliation never sends, never treats a missing receipt as proof of non-delivery, and never restarts a stopped sequence. Provider acceptance, delivery, reply, and booking are distinct measured outcomes.

## Contact readiness

Campaign dispatch requires evidence for the current normalized email address, dated within 30 days, from either a stored validation-provider receipt or an explicitly attributed, owner-attested external verification report. Imported reports are labeled imported verification. Legacy `valid` values without evidence remain unverified. Syntax checks and lead enrichment do not establish mailbox validity.

Suppression survives reimport and revalidation. A reply stops prospecting follow-ups before its body is fetched or classified. Reply eligibility is a separate conversation decision: it must preserve suppression, human takeover, and per-conversation limits without requiring a replied lead to re-enter a cold sequence.

## Agent roles

1. Copy agent drafts from a stored offer brief, evidence, approved claims, tone and call to action. Generated text is a draft until its campaign revision is approved. It cannot invent proof or infer deliverability from a heuristic score.
2. Conversation agent classifies a stored inbound message and proposes a reply. Incoming text is untrusted data. It cannot change policy, select another organization, or invoke tools directly.
3. Approved automation may select configured reply actions within confidence, intent and reply-count limits. Sensitive, unclear and unsupported requests enter an operator queue. Human takeover invalidates queued automation.
4. Booking and voice agents invoke configured provider adapters. An appointment needs a real provider receipt. A callback needs explicit eligibility and a configured phone destination; email interest alone does not supply either.

Model identity, prompt/policy version, source message, decision, and effect receipt remain attributable. Missing credentials or unavailable provider capabilities produce visible setup blockers.

## Operator journey

Connect Winnr → observe domains and mailboxes → configure warm-up → import and verify leads → write and approve campaign copy → select sender identity, schedule and limits → inspect readiness → start → monitor sends, replies, holds and bookings.

The launch screen explains missing setup inputs and links to the relevant action. The inbox offers human reply and takeover controls. The operations view shows unknown outcomes and worker health with timestamps, and provides a kill switch. No successful zero count is shown for an unavailable measurement.

## Current implementation boundary

The foundation through lead validation028, manual replies029, and copy/conversation agents030 are integrated and independently reviewed. Operations031 has closed its stop-race, fairness and truthful settlement findings; one body-storage deadline fix is in progress. Receipt reconciliation032 has passed independent review, including immutable provider-account version and authenticated provider event-time checks.

The integrated state through032 passes full strict TypeScript, production build and lint (zero errors,25 existing warnings). The latest affected run passed366 tests including15 actual PostgreSQL operations cases. These are local development checks. Final integrated gates will run again after the operator UI and downstream integration work.

The real baseline plus migrations020-028 passed eight chain checks against the measured196 columns,66 constraints and49 indexes. CI and the cross-module chain are being extended through032. CRM/booking/voice adapters, final browser checks, landing, deployment and the controlled live pilot remain outstanding. The Winnr account has no domains or mailboxes. No production migration or outbound effect has occurred.
