# Product and System Architecture

## North-star outcome

Upmax turns a policy-approved lead into a qualified, attended appointment while preserving deliverability, consent, tenant isolation, and a complete audit trail.

## System ownership matrix

| Capability | System of record | Upmax responsibility |
|---|---|---|
| Domains, DNS, mailboxes, warmup, SMTP/IMAP health | Winnr | Provisioning requests, mappings, policy, cached health, operator UX |
| Campaigns, sequences, send state, suppressions | Upmax | Full ownership |
| Contacts, opportunities, pipeline | GHL | Sync, identifiers, reconciliation |
| Calendar and appointments | GHL | Availability/booking orchestration, mirror status |
| Text qualification/booking agent | CloseBot | Routing policy, context, audit, escalations |
| Calls, recordings, transcripts, call analysis | Retell | Eligibility, initiation, result ingestion, GHL summary |
| Lead discovery/enrichment | Apollo or imported source | Provider abstraction, provenance, scoring |
| Email validation | ZeroBounce | Decision policy and stored result/provenance |

## Canonical flow

```text
Apollo / CSV / GHL
        |
        v
Lead intake -> enrichment -> validation -> policy eligibility
        |
        v
Campaign state machine -> atomic suppression check -> Winnr send
        |                                      |
        |                                      v
        |                              delivery/reputation events
        v
Winnr inbox/reply event -> canonical event ledger -> stop/pause rules
        |                                      |
        v                                      v
GHL contact + custom email conversation    analytics/alerts
        |
        v
CloseBot qualifies and replies through GHL custom provider
        |
        v
GHL calendar booking -> appointment webhook -> Upmax conversion
        |
        v
Optional Retell handoff for consented/warm call, reminder, or no-show recovery
```

## GHL custom email bridge

Upmax registers as a GHL conversation provider.

1. A Winnr reply is normalized and attached to a canonical lead/contact.
2. Upmax creates or updates the GHL contact.
3. Upmax posts the reply to GHL as an inbound email/custom conversation message with stable external IDs.
4. CloseBot observes the GHL source and qualifies the lead.
5. When CloseBot/GHL sends an outbound response, GHL calls Upmax's signed provider delivery webhook.
6. Upmax verifies the signature, resolves the mailbox/thread, checks suppression and policy, and sends through Winnr.
7. Upmax updates GHL message status and its own event ledger.

This makes replies visible in GHL and usable by CloseBot while preserving Winnr as the sending substrate.

## Core bounded contexts

- **Identity and tenancy** — organizations, roles, secrets, provider connections.
- **Lead intelligence** — sources, enrichment, verification, provenance, scoring.
- **Campaign orchestration** — templates, sequences, schedules, variants, approvals.
- **Messaging** — threads, messages, provider routing, tracking, attachments.
- **Policy and suppression** — channel eligibility, DNC, opt-out, complaints, quiet hours.
- **Revenue automation** — qualification, opportunity state, booking, reminders, handoff.
- **Infrastructure health** — mailbox/domain status, warming, capacity, quarantine.
- **Event platform** — canonical events, inbox/outbox, retries, replay, reconciliation.
- **Analytics and experimentation** — funnel metrics, deliverability, attribution, evaluations.

## Canonical event envelope

Every provider event maps to:

```ts
type CanonicalEvent<T> = {
  id: string
  type: string
  version: number
  tenantId: string
  occurredAt: string
  receivedAt: string
  source: 'upmax' | 'winnr' | 'ghl' | 'closebot' | 'retell' | 'apollo' | 'zerobounce'
  sourceEventId: string
  correlationId: string
  causationId?: string
  subject: { leadId?: string; campaignId?: string; messageId?: string; appointmentId?: string }
  data: T
}
```

Uniqueness is enforced on `(tenant_id, source, source_event_id)`. Effects are emitted through a transactional outbox. Consumers store idempotency receipts.

## Policy decisions

- Email is the only cold outbound channel in Release A.
- SMS and AI voice require explicit channel eligibility; interest in an email does not automatically create blanket consent.
- Retell is initially used for inbound calls, requested callbacks, appointment confirmation, and no-show recovery where policy permits.
- Social DMs and paid-ad orchestration are post-beta because platform permissions and attribution add scope without proving the email-to-appointment core.
- New campaign copy and targeting require one approval. Approved sequences may run autonomously until an alert or stop rule fires.

## Vendor resilience

Each provider implements a stable port, for example `EmailInfrastructureProvider`, `CrmProvider`, `ConversationAgentProvider`, `VoiceProvider`, `LeadDataProvider`, and `EmailValidationProvider`. Store provider IDs only in mapping tables. No domain object imports a vendor SDK type.

Smartlead can implement `CampaignExecutionProvider` as a temporary fallback or parity harness, but the primary production path is the native Upmax campaign engine over Winnr.
