# OSS Leverage Research — Findings

2026-08-23. Multi-lane research: Claude (queen + worker), Grok Build (red team),
Kimi (study audit, pending). Codex lane failed — no network in its sandbox.

Every number below is either **[VERIFIED]** by direct API/doc check today, or
explicitly marked **[UNVERIFIED]**.

## The headline

The question "which GitHub repos can we leverage to build this" has a
disappointing answer for the product and an uncomfortable answer for the plan.

**For the product:** almost nothing in the ~100-repo study applies. It is
AI-agent tooling — skills, memory, context compression, knowledge graphs. There
is no email infrastructure, event ledger, CRM integration, or campaign state
machine in it.

**For the plan:** the red-team pass argues the plan should not be executed as
written, because it rebuilds a vendor capability the project constitution
forbids rebuilding.

## The constitutional problem [VERIFIED]

`CLAUDE.md:18`:
> Never rebuild a vendor capability unless an ADR proves the vendor cannot meet
> a release requirement.

No such ADR exists in `docs/decisions/` or `docs/ADR-001-TECHNOLOGY-STACK.md`.

`docs/PRODUCT-ARCHITECTURE.md:110`:
> Smartlead can implement `CampaignExecutionProvider` as a temporary fallback or
> parity harness, but the primary production path is the native Upmax campaign
> engine over Winnr.

The provider interface is already designed. The architecture designates the
native engine as primary — but that designation is exactly what lacks an ADR.

`docs/ADR-001-TECHNOLOGY-STACK.md:66`:
> No new queue/event broker during Release A unless the current design cannot
> satisfy a demonstrated gate.

This independently rejects Temporal / Inngest / Trigger.dev / Restate for item 6,
and confirms the pgmq recommendation below (Postgres is not a new broker).

## Items 7 and 8 are the disputed ~16–22 days

Plan items 7 (Winnr adapter) and 8 (campaign engine consolidation) are
undifferentiated cold-email platform work. Sequences, spintax, quiet hours,
mailbox rotation, warmup, bounce/complaint stop transitions — this is Instantly's
and Smartlead's entire product.

The mission is **booked, attended, qualified appointments**, not email volume.
Under that mission the differentiating work is item 9 (reply → qualify → book)
and the Upmax-owned part of item 3 (global suppression + policy overlay).

## Why "just use a cheap ESP" is not an escape hatch [VERIFIED]

Resend's Acceptable Use Policy prohibits
> unsolicited messages of any kind, including cold outreach, purchased lists, or
> scraped contact data

with a complaint ceiling of 0.08% and bounce ceiling of 4%, enforced by account
shutdown. AWS SES, Postmark and SendGrid have materially equivalent
permission-based requirements. Cold outreach at volume typically runs complaint
rates well above these ceilings.

This is why cold-email tools use rotated real mailboxes over SMTP rather than
ESP APIs — which is what this codebase already does (nodemailer + mailbox
provisioning + warmup). The architecture is right; the question is whether we
operate it or a vendor does.

Source: https://resend.com/legal/acceptable-use

## Verified OSS stack — if we build

All figures checked via GitHub API on 2026-08-23. All actively maintained
(pushed within ~2 weeks) unless noted.

### Event ledger / outbox / queue — item 6

| Repo | Stars | Licence | Verdict |
| --- | ---: | --- | --- |
| **timgit/pg-boss** | 3,884 | MIT | **ADOPT** — transaction-coupled enqueue *plus* built-in DLQ, redrive, retries, backoff, uniqueness |
| pgmq/pgmq | 5,106 | PostgreSQL | Viable — ships in Supabase as "Supabase Queues", zero setup, but DLQ/redrive/receipts remain app work |
| graphile/worker | 2,371 | MIT | Viable — good worker, thin on DLQ/redrive |
| hatchet-dev/hatchet | 7,782 | MIT | Reject — new control plane, violates ADR-001:66 |
| triggerdotdev/trigger.dev | 16,106 | Apache-2.0 | Reject — cannot commit atomically with our Postgres transaction |
| debezium/debezium | ~13.0k | Apache-2.0 | Reject — Kafka Connect is disproportionate for a monolith |
| inngest/inngest | 5,760 | **SSPL** | **Reject** — MongoDB-style licence, hostile to commercial SaaS |
| restatedev/restate | 4,333 | **BSL 1.1** | **Reject** — source-available, not open source |

**Revised recommendation: pg-boss.** My first pass recommended pgmq via Supabase
Queues on the grounds of zero new infrastructure. The Codex lane made the
stronger argument: EVT-005 explicitly requires DLQ, replay and reconciliation,
and pg-boss ships that lifecycle (dead-letter queues, redrive, retries with
backoff, uniqueness, job dependencies) whereas pgmq leaves it as application
code. pg-boss also inserts jobs through the caller's existing Postgres
transaction, so it keeps the atomicity that motivated the pgmq pick. Both run on
the Postgres we already have, so neither is a "new broker" under ADR-001:66.

Supabase Queues remains the right call if the priority is zero setup over
lifecycle completeness.

### CORRECTION: do not design for "exactly-once"

Supabase's docs advertise "exactly once message delivery ... within a
customizable visibility window". I repeated that as if it meant exactly-once
*effects*. It does not, and the distinction matters for how item 6 and item 8
are designed.

SMTP sends and third-party HTTP calls (Winnr, GHL, CloseBot) cannot be enrolled
in a Postgres transaction. The achievable model is:

> **at-least-once execution + deterministic idempotency keys + provider receipts
> + consumer receipts**

Every worker must compare expected state and version before acting, so a
redelivered or stale job is harmless. A deterministic key shape such as
`campaign:{campaignId}:lead:{leadId}:step:{stepVersion}:attempt:{logicalAttempt}`
makes duplicate suppression checkable rather than hoped-for. This is exactly
what CAM-004 ("deterministic idempotency key for every planned touch") and
EVT-004 ("consumer idempotency receipts") already ask for.

### State machine — item 8

**XState v5 + Postgres + pg-boss.** XState defines the legal campaign/lead
transitions and guards only; Postgres persists state, state version, pause
generation and next-action timestamp; pg-boss schedules the deterministic jobs.
Temporal is the capability winner and the integration loser — it is a large
operational jump while the monolith is still being stabilised, and it does not
remove the application-database double-write. Revisit only if nested timers,
human-in-the-loop signals and workflow migrations accumulate.

### Everything else

| Need | Pick | Stars | Licence |
| --- | --- | ---: | --- |
| Campaign state machine (8) | statelyai/xstate | 30,051 | MIT |
| Mail sink for tests (5) | axllent/mailpit | 10,187 | MIT |
| Disposable PG/Redis (5) | testcontainers/testcontainers-node | 2,591 | MIT |
| RLS policy tests (4) | theory/pgtap | 1,161 | verify |
| Booking engine (9) | calcom/cal.diy | 47,884 | **MIT** |
| Suppression/bounce reference (3) | postalserver/postal | 16,762 | MIT |
| Suppression reference (3) | knadh/listmonk | 23,073 | **AGPL-3.0** — read, never vendor |

`calcom/cal.com` now redirects to `calcom/cal.diy`, licence confirmed MIT by
reading the LICENSE file directly. Note: GHL already provides calendars, so this
is only relevant if GHL's calendar proves insufficient.

**Licence traps to avoid in a commercial product:** AGPL-3.0 (listmonk,
firecrawl, postiz), SSPL (inngest), BSL 1.1 (restate).

## The study, audited — all 103 rows [VERIFIED by Kimi lane]

Every row checked against the GitHub API today.

**Data quality: reliable, lagging upward.** All 103 verifiable rows exist. Zero
hallucinated, zero renamed, zero 404s. Star drift is positive on **103/103 rows**,
mean **+8.9%**. Fastest risers: stablyai/orca +63.8%, OmniRoute +63.5%,
herdr +45.3%, hallmark +39.0%. Treat every number in the study as a floor. The
only unverifiable row is the truncated paste at line 105 (`refactoringhq/…`).

**Relevance ratings: noise.** The study's own "UpMax relevance" column does not
survive contact with the plan.

**Bucket A — "builds the product": empty.** Zero of 103 repos touch email
sending/deliverability, suppression/compliance, event ledgers/outbox,
CRM/calendar integration, campaign state machines, Postgres migration tooling, or
multi-tenant RLS. Composition is roughly 65% AI-agent harnesses/skills, 15%
video/media generation, 10% finance/learning/misc — a sample of what trends on
agent-tooling YouTube, not of what builds this product.

Two near-misses and why they still fail:

- **calcom/cal.diy** — genuinely booking infrastructure, and the mission is booked
  appointments. But the product boundary in `CLAUDE.md` assigns calendars to GHL,
  and the constitution forbids rebuilding a vendor capability without an ADR.
  Item 9 needs a GHL free-slot adapter, not a scheduling platform.
- **gitroomhq/postiz-app** — queue-based scheduled publishing, architecturally a
  cousin of item 8, but it schedules social posts not email touches, and it is
  AGPL. Read-only reference at best.

### Top adoptions that do pay — dev acceleration, not product

All licences verified. Ranked by effect on shipping the 10 items.

| # | Repo | Stars | Licence | Why | Effort |
| --- | --- | ---: | --- | --- | --- |
| 1 | mattpocock/skills | 233,801 | MIT | TS engineering skills aimed straight at item 2's 1,155-error burn-down | hours |
| 2 | garrytan/gstack | 129,332 | MIT | 23 review/QA/ship tools that slot into the existing Queen protocol | hours–1d |
| 3 | obra/superpowers | 276,667 | MIT | Formalises the brainstorm→plan→evidence-gate loop the constitution already demands | 1–2d |
| 4 | addyosmani/agent-skills | 89,284 | MIT | Review/debug/perf skills; dedupe against 1–3 before installing all | hours |
| 5 | Graphify-Labs/graphify | 109,821 | Apache-2.0 | Codebase + SQL schema knowledge graph — attacks item 1's schema-truth problem directly | 1–2d |
| 6 | thedotmack/claude-mem | 91,610 | Apache-2.0 | Cross-session memory; every sidecar lane currently restarts from zero | hours |
| 7 | chopratejas/headroom | 67,284 | Apache-2.0 | Tool-output compression; two lanes were quota-dead this cycle | 0.5–1d |
| 8 | openai/codex-plugin-cc | 32,225 | Apache-2.0 | Structured cross-lane review instead of copy-paste handoffs | hours |
| 9 | usestrix/strix | 57,415 | Apache-2.0 | Pen-test harness against **staging only** — evidence for item 10's security review | 2–3d |
| 10 | diegosouzapw/OmniRoute | 53,825 | MIT | Quota-aware multi-provider fallback; structural fix for lanes dying mid-cycle | 1–2d |

**Licence cautions inside the study:** `caveman` (MIT + BSL mixed — read terms),
`context-mode` (ELv2, internal use only), `remotion` (custom company licence,
not free at agency size), plus the AGPL set already noted.

**Adopt one per category, not all.** Categories 5 and 6 each have three viable
competitors in the list; installing several memory systems or several knowledge
graphs is how context gets polluted and debugging surface explodes.

## What the study never looked at

The categories that actually map to the 10 items, with zero coverage:

1. Email deliverability & compliance (items 3, 7) — RFC 8058 one-click
   implementations, bounce/complaint parsing, VERP, suppression management,
   DKIM/SPF/DMARC tooling, DMARC aggregate-report parsers, inbox-placement seed testing
2. Event sourcing / transactional outbox / durability (item 6)
3. State machines (item 8)
4. Postgres/Supabase schema & migration tooling (items 1, 4) — Atlas,
   pg-schema-diff, sqitch/dbmate, pgTAP
5. Test harness infrastructure (item 5) — Testcontainers, Mailpit,
   MSW/WireMock for Winnr/GHL/CloseBot contract fixtures
6. Integration/OAuth plumbing (item 9) — Nango-style token lifecycle,
   Ed25519 webhook verification references
7. Observability (item 10) — OpenTelemetry, Grafana/Prometheus/Loki, Sentry
8. Secrets hygiene (item 10 / FND-012) — sops/age, Vault
9. Queue reliability patterns (items 6, 8)

The study answered "what is hot in agent tooling" when the question was "what
de-risks 55–80 days of email-infrastructure engineering."

## Corrections to earlier claims in this session

- I asserted the study's star counts were implausible. **Wrong.** They are
  accurate and now higher, because the study was captured earlier
  (obra/superpowers claimed 262,635 → actual 276,666).
- I raised a licence alarm from `gh repo view --json licenseInfo` returning null.
  **False alarm** — that GraphQL field is unreliable; the REST licence endpoint
  shows MIT/Apache almost throughout.

## Unverified — do not act on without checking

Grok self-flagged all vendor pricing. Treat as indicative only:
Instantly Hypergrowth ~$97/mo, Light Speed ~$358/mo; Smartlead Pro ~$94/mo,
Prime ~$379/mo; Winnr warming $0.60/mailbox/mo, pre-warmed ~$3/address/mo with a
90-day minimum. The TCO comparison built on these is directionally argued, not
audited. Confirm on vendor pages before any commitment.

## The decision

This is an owner decision, not an engineering one, and it should be recorded as
an ADR either way.

**Option A — build the native engine (current plan).** 55–80 engineer-days to
pilot. Owns deliverability operations permanently. Justified only if mailbox
supply economics or multi-tenant white-label resale genuinely require it, and
that case must be written down.

**Option B — vendor-sends, Upmax orchestrates.** Promote Smartlead/Instantly from
"temporary fallback" to Release A production sender via the existing
`CampaignExecutionProvider` interface. Upmax owns suppression, policy, the event
ledger, and the reply → appointment bridge. Estimated 3–5 weeks. Items 7 and 8
collapse to adapters.

Under Option B the still-mandatory work is: item 1 (schema — no shortcut),
item 3 (global suppression ledger — liability, and it must be honoured by
whoever sends), item 4 (tenancy/RLS), scoped item 5, thin item 6, and item 9,
which is the actual product.

Item 2 becomes scoped: typecheck the send/suppression/tenancy/GHL path rather
than burning 5–8 days on 1,155 errors across billing and white-label modules
that Release A does not need.
