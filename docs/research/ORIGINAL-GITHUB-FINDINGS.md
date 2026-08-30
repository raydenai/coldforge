# Original GitHub Research — Beyond the Channel Studies

2026-08-23/24. Independent GitHub API sweep by Claude, deduplicated against the
192-repo TNNT study (`/Users/sezars/projects/upmax-ai/docs/research/`) and the
earlier 104-repo study.

**Every figure verified live via `gh api` on the date above.** Anything marked
`NEW` does not appear in either channel study.

## Why this finds different things

Both channel studies sample what trends on agent-tooling YouTube. That is a
sample of *content*, not of *infrastructure*. Production email plumbing, outbox
patterns, and schema-diff tools do not make good videos, so they are structurally
absent — the TNNT study has 3 email repos out of 192, and the earlier study had
zero bucket-A entries out of 103.

This sweep queried GitHub by topic and domain keyword instead: `topic:cold-email`,
`topic:deliverability`, `topic:transactional-email`, `topic:event-sourcing`,
`topic:database-migrations`, `topic:row-level-security`, plus targeted lookups.

---

## A. Cold email and deliverability — the actual product domain

| Repo | Stars | Licence | Last push | Note |
| --- | ---: | --- | --- | --- |
| oblien/openship | 11,543 | Apache-2.0 | 2026-08-24 | **In TNNT study.** "Free open-source cold email infrastructure" — the single most on-domain repo either study surfaced |
| Billionmail/BillionMail | 15,445 | **AGPL-3.0** | 2026-06-11 | NEW. Mail server + newsletter + marketing suite. Reference only — AGPL |
| Mailtrain-org/mailtrain | 5,746 | **GPL-3.0** | 2025-10-05 | NEW. Self-hosted newsletter. Copyleft; ~10mo stale |
| Notifuse/notifuse | 2,071 | **AGPL-3.0** | 2026-08-18 | NEW. Newsletter + transactional. Reference only |
| **AfterShip/email-verifier** | 1,601 | **MIT** | 2026-08-20 | **NEW. Go library, verifies email without sending. Direct ZeroBounce alternative for LEAD-004** |
| MattKeeley/Spoofy | 772 | NOASSERTION | 2025-12-08 | NEW. Checks whether a domain can be spoofed (SPF/DMARC analysis) — useful for domain-health checks |
| buyukakyuz/email-sleuth | 421 | MIT | 2025-12-20 | NEW. Discover + verify emails from name + domain |
| CosmoBlk/email-marketing-bible | 277 | MIT | 2026-06-30 | NEW. 55k-word email-marketing skill, 908 sources |
| **warmbly/warmbly** | 74 | **Apache-2.0** | 2026-08-23 | **NEW. "Open-source AI-native cold outreach and email warmup" — tiny but exactly our domain and active** |
| **LeadMagic/smartlead-mcp-server** | 21 | **MIT** | 2025-07-02 | **NEW. Smartlead MCP server — directly relevant under Option B (vendor-sends)** |

### Provider-abstraction layer — genuinely useful for item 7

This category did not appear in either study at all, and it maps onto the
`CampaignExecutionProvider` interface the architecture already defines.

| Repo | Stars | Licence | Last push | Note |
| --- | ---: | --- | --- | --- |
| **opencoredev/email-sdk** | 436 | **MIT** | 2026-08-20 | **NEW. One SDK across 23 transactional-email adapters** |
| **productdevbook/unemail** | 244 | **MIT** | 2026-06-19 | **NEW. Unified email API across 18 providers (SMTP, Resend, SES, Postmark…)** |
| goposta/posta | 251 | Apache-2.0 | 2026-08-21 | NEW. Self-hosted email delivery platform |
| 0xdps/emailflare | 222 | MIT | 2026-08-23 | NEW. Built on Cloudflare Email Sending |
| craigmccaskill/posthorn | 209 | Apache-2.0 | 2026-08-22 | NEW. Gateway between apps and a transactional provider |
| savvyagents/larasend | 485 | MIT | 2026-08-15 | NEW. Self-hosted transactional platform over your own SES |

Caveat that applies to this whole row: these abstract **transactional** ESPs, and
every mainstream transactional ESP forbids cold outreach (verified: Resend AUP
prohibits "unsolicited messages of any kind, including cold outreach"). Useful as
an adapter-shape reference and for genuinely transactional mail (unsubscribe
confirmations, internal alerts) — not as the cold-send path.

### MTA references

| Repo | Stars | Licence | Last push |
| --- | ---: | --- | --- |
| stalwartlabs/stalwart | 14,321 | check | 2026-08-23 |
| reacherhq/check-if-email-exists | 9,476 | check | 2026-03-17 |
| haraka/Haraka | 5,612 | MIT | 2026-08-13 |
| postalserver/postal | 16,762 | MIT | 2026-06-03 |

Running our own MTA turns us into a mail-operations company. Read for the bounce
and event taxonomy; do not deploy.

---

## B. Event ledger / outbox — item 6

| Repo | Stars | Licence | Last push | Note |
| --- | ---: | --- | --- | --- |
| **kgrzybek/modular-monolith-with-ddd** | 13,954 | **MIT** | 2024-06-04 | **NEW. Reference architecture for exactly our shape: modular monolith + DDD + outbox. Read it, don't import it (.NET)** |
| ThreeDotsLabs/watermill | 9,853 | MIT | 2026-08-06 | NEW. Event-driven library (Go) — good pattern reference |
| kurrent-io/KurrentDB | 5,848 | check | 2026-08-22 | NEW. Event-sourcing database (formerly EventStore) |
| obsidiandynamics/goharvest | 207 | BSD-3 | 2022-11-10 | NEW. Postgres→Kafka outbox harvester. **UNMAINTAINED** |

These reinforce rather than replace the earlier pick: **pg-boss** on the Postgres
we already run, per ADR-001:66 ("no new queue/event broker during Release A").

---

## C. Schema and migration — items 1 and 4

The single biggest gap in both studies, and item 1 is the tightest constraint in
the whole plan.

| Repo | Stars | Licence | Last push | Note |
| --- | ---: | --- | --- | --- |
| pressly/goose | 11,354 | check | 2026-08-22 | NEW |
| flyway/flyway | 10,023 | Apache-2.0 | 2026-08-13 | NEW |
| **ariga/atlas** | 8,674 | **Apache-2.0** | 2026-08-02 | **NEW. Schema-as-code with declarative diffing — directly applicable to reconciling live DB vs migrations** |
| **amacneil/dbmate** | 7,159 | **MIT** | 2026-08-19 | **NEW. Lightweight, framework-agnostic, plain SQL — good fit for forward-only migrations** |
| **sqldef/sqldef** | 3,145 | check | 2026-08-23 | **NEW. Idempotent schema management — computes the diff between desired and actual schema. Precisely the item-1 problem** |
| theory/pgtap | 1,161 | check | 2026-08-23 | Unit testing inside Postgres — the tool for RLS negative-authorization tests (SEC-008) |

**`ariga/atlas` and `sqldef/sqldef` are the highest-value finds in this document
for the work that is actually blocking.** Item 1 is "reconcile a live database
against a migration set that does not apply" — that is a schema-diff problem, and
these are schema-diff tools. Neither study contains either.

---

## D. Integration plumbing — item 9

| Repo | Stars | Licence | Last push | Note |
| --- | ---: | --- | --- | --- |
| **NangoHQ/nango** | 11,570 | check | 2026-08-24 | **NEW. OAuth token lifecycle + integrations for 400+ APIs. Maps directly onto GHL-001 (scoped tokens, encrypted storage, refresh)** |
| panoratech/Panora | 1,034 | **AGPL-3.0** | 2025-10-26 | NEW. Integration engine. AGPL + stale |

### Negative finding: there is no usable GoHighLevel SDK

Searched thoroughly. The entire GHL ecosystem on GitHub:

| Repo | Stars | Licence |
| --- | ---: | --- |
| mastanley13/GoHighLevel-MCP | 194 | **none** |
| BusyBee3333/Go-High-Level-MCP-2026-Complete | 99 | none |
| basicmachines-co/open-ghl-mcp | 48 | AGPL-3.0 |
| tenfoldmarc/ghl-mcp | 17 | none |

All MCP servers, all tiny, mostly unlicensed. **The GHL adapter must be built
from their API documentation.** Nango can carry the OAuth/token half; the
contact, opportunity, calendar and conversation-provider mapping is ours.

Same for CloseBot — no OSS client exists. Retell has `PatterAI/Patter`
(1,039★, MIT) as an *alternative* voice SDK, not a client.

---

## E. Test harness and observability — items 5 and 10

| Repo | Stars | Licence | Note |
| --- | ---: | --- | --- |
| mswjs/msw | 18,154 | MIT | NEW. Request-level mocking — Winnr/GHL/CloseBot contract fixtures |
| wiremock/wiremock | 7,342 | Apache-2.0 | NEW. Service virtualisation, record/replay |
| axllent/mailpit | 10,187 | MIT | Mail sink |
| testcontainers/testcontainers-node | 2,591 | MIT | Disposable Postgres/Redis |
| open-telemetry/opentelemetry-js | 3,447 | Apache-2.0 | NEW. Structured tracing (OPS-001) |

---

## Ranked: what to actually pull in, mapped to plan items

1. **ariga/atlas** or **sqldef/sqldef** → item 1. Schema-diff the live DB against
   the migration set instead of hand-reconciling 112 vs 98 tables. Highest
   leverage in this document, because item 1 blocks four other items.
2. **theory/pgtap** → item 4. RLS negative-authorization tests (SEC-008).
3. **AfterShip/email-verifier** (MIT) → LEAD-004. Replaces or backstops
   ZeroBounce; no per-check cost.
4. **NangoHQ/nango** → item 9. GHL OAuth token lifecycle, encrypted storage,
   refresh.
5. **mswjs/msw** + **testcontainers-node** + **mailpit** → item 5. The whole
   harness, all MIT.
6. **oblien/openship** → items 3, 7, 8. Read it before building anything: it is
   Apache-2.0 cold-email infrastructure, pushed yesterday, and it is the closest
   existing thing to what Release A proposes to build.
7. **opencoredev/email-sdk** / **productdevbook/unemail** → item 7 adapter shape.
8. **kgrzybek/modular-monolith-with-ddd** → item 6. Read the outbox
   implementation; do not import.
9. **LeadMagic/smartlead-mcp-server** → only under Option B.
10. **open-telemetry/opentelemetry-js** → item 10.

## Licence: what actually restricts us (corrected)

An earlier version of this document called AGPL a "blacklist". That was wrong and
too blunt. Correcting it, because the distinction changes how we should use these
repos.

**What copyleft actually restricts:** distributing, or offering as a network
service, *derivative works of the licensed code*. AGPL-3.0 §13 extends the
trigger to network use, which is why it matters for SaaS specifically.

**What it does not restrict:** reading the code, studying the architecture,
learning the domain model, or independently implementing the same *behaviour*.
Algorithms, patterns and data-model shapes are not copyrightable — expression is.
A clean-room reimplementation informed by having read an AGPL project is normal
engineering practice.

So the correct posture is a **reference tier**, not a blocklist. For our exact
gaps, the copyleft projects are the *best available teachers*, because they are
the only mature open implementations of the things we have to get right:

| Repo | Licence | What to learn from it |
| --- | --- | --- |
| **knadh/listmonk** | AGPL-3.0 | The reference implementation for our item 3. Global blocklist model, per-list subscription status, bounce ingestion and processing, unsubscribe token design |
| **Billionmail/BillionMail** | AGPL-3.0 | Full mail-server + campaign stack — how the sending, warmup and reputation pieces fit together |
| **Notifuse/notifuse** | AGPL-3.0 | Newsletter + transactional in one system; message/template versioning |
| **gitroomhq/postiz-app** | AGPL-3.0 | Queue-based scheduled publishing — the scheduler shape for item 8 |
| **Mailtrain-org/mailtrain** | GPL-3.0 | Older, simpler subscription/bounce model; easy to read end-to-end |
| **eracle/OpenOutreach** | GPL-3.0 | Lead-gen → ICP fit → CSV export pipeline |
| **mautic/mautic** | GPL-3.0 | The richest DNC model in open source: channel-level suppression with reasons (unsubscribe / bounce / manual) |
| **panoratech/Panora** | AGPL-3.0 | Integration-engine shape for item 9 (stale, Oct 2025) |

**The single hard line:** do not paste their source into the commercial product.
Read, understand, design, then write our own. Where a behaviour is subtle
(bounce classification rules, unsubscribe token formats, suppression precedence),
write down *why* in an ADR so the provenance is our reasoning, not their file.

**Genuinely unusable — no licence at all** (default all-rights-reserved, so even
copying a snippet is infringement, and there is no grant to rely on):
mastanley13/GoHighLevel-MCP, BusyBee3333/Go-High-Level-MCP-2026-Complete,
tenfoldmarc/ghl-mcp, Cold-IQ/ColdIQ-s-GTM-Skills. These can still be read as
documentation of GHL's API surface, which is a fact about GHL, not their IP.

**SSPL (inngest) and BSL 1.1 (restate)** remain rejected, but for a different
reason than copyleft: those are *deployment* restrictions on running the software
as a service, which is exactly what we would be doing. Reading them is still fine.
