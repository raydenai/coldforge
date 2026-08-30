# ADR-007: Campaign Execution — Native Engine vs Vendor Sender

**Status:** Proposed — requires owner decision
**Date:** 2026-08-24
**Supersedes:** the DECISION-LOG row of 2026-08-22, "Build the native Upmax
sequencer; keep Smartlead as parity/fallback", which recorded the decision but
did not satisfy the constitutional test below.

## Why this ADR exists

`CLAUDE.md:18`:

> Never rebuild a vendor capability unless an ADR proves the vendor cannot meet a
> release requirement.

`docs/PRODUCT-ARCHITECTURE.md:110` designates the native engine as primary:

> Smartlead can implement `CampaignExecutionProvider` as a temporary fallback or
> parity harness, but the primary production path is the native Upmax campaign
> engine over Winnr.

That designation is exactly the rebuild the constitution gates. No ADR proving
vendor inadequacy exists. This ADR either supplies that proof or reverses the
designation.

## Context

Verified state of the codebase as of 2026-08-24 (`docs/BASELINE-FND-001.md`,
`docs/PRODUCTION-PLAN.md`):

- Winnr, GHL, CloseBot, Retell and the canonical event ledger are **zero code**.
- `tsc --noEmit` crashes; 1,155 type errors sit behind the crash; `npm run build`
  has never succeeded.
- Migrations do not apply from scratch. 11 tables the application queries 234
  times have no DDL anywhere in the repository.
- **No unsubscribe endpoint exists**, while `src/lib/sending/sender.ts:242` emits
  `List-Unsubscribe-Post` — and no `List-Unsubscribe` header to pair with it.
- **No pre-send suppression check exists.** The only `unsubscribed` reference in
  the send path counts them for statistics.
- Three competing send paths exist (`src/lib/sending/`, `src/lib/smtp/queue.ts`,
  `src/lib/queue/processors/campaign.ts`).

Plan items 7 (Winnr adapter) and 8 (campaign engine consolidation) total an
estimated 16–22 engineer-days and represent the disputed scope.

## Decision required

### Option A — Native engine (current designation)

Build the Winnr adapter and one canonical campaign/lead state machine. Upmax owns
sequencing, scheduling, mailbox allocation, warmup orchestration and deliverability
operations permanently.

**Estimated:** 55–80 engineer-days to an owner-approved pilot.

### Option B — Vendor sends, Upmax orchestrates

Promote Smartlead or Instantly from "temporary fallback" to the Release A
production `CampaignExecutionProvider`. Items 7 and 8 collapse to adapters. Upmax
owns the global suppression ledger, policy enforcement, the event ledger, and the
reply → qualify → book bridge — the parts that are actually differentiating under
a mission of *booked, attended, qualified appointments*.

**Estimated:** 3–5 weeks to the same gate.

## Evidence

**[VERIFIED] Mainstream transactional ESPs prohibit cold outreach.** Resend's
Acceptable Use Policy prohibits "unsolicited messages of any kind, including cold
outreach, purchased lists, or scraped contact data", with a 0.08% complaint
ceiling and 4% bounce ceiling enforced by account shutdown. AWS SES, Postmark and
SendGrid impose materially equivalent permission-based requirements.

*Consequence:* "just use a cheap ESP" is not an option under either A or B. The
sending path must be rotated real mailboxes (which the codebase already
implements) or a cold-email vendor whose AUP permits the traffic. This is
evidence **for** using a vendor, not against.

**[VERIFIED] No usable GoHighLevel SDK exists.** The entire GHL ecosystem on
GitHub is four MCP servers at 194 / 99 / 48 / 17 stars, three with no licence at
all. Item 9's adapter must be hand-built from GHL's API documentation under
either option. `NangoHQ/nango` (11,570★) can carry the OAuth/token half.

*Consequence:* item 9 cannot be shortcut and is on the critical path regardless.
This is the strongest argument for spending the remaining budget there.

**[VERIFIED] The constitution already forbids the broker sprawl Option A tends
toward.** `docs/ADR-001-TECHNOLOGY-STACK.md:66` — "No new queue/event broker
during Release A unless the current design cannot satisfy a demonstrated gate."

**[UNVERIFIED — confirm on vendor pages before acting]** Indicative list pricing:
Instantly Hypergrowth ~$97/mo, Light Speed ~$358/mo (500k emails); Smartlead Pro
~$94/mo, Prime ~$379/mo. Winnr warming ~$0.60/mailbox/mo, pre-warmed ~$3/address/mo
with a 90-day minimum. The total-cost comparison built on these figures is
directionally argued, not audited.

## What would justify Option A

Option A is defensible only if at least one of these is true and written down:

1. **Mailbox supply economics.** Vendor per-seat or per-mailbox pricing breaks at
   our planned volume in a way that a Winnr-direct relationship fixes.
2. **Multi-tenant resale.** We intend to sell this capability to client
   workspaces, and vendor terms of service prohibit the white-label resale model.
   (`src/lib/whitelabel/` suggests this is contemplated.)
3. **A capability gap.** A specific Release A requirement that Instantly and
   Smartlead demonstrably cannot meet. None has been documented.

Absent all three, the constitutional test fails and Option B is the compliant
path.

## Recommendation

**Option B.** The mission is booked appointments, not email volume. Sequencing,
spintax, quiet hours, mailbox rotation and warmup are undifferentiated — they are
the vendors' entire product. The differentiating work is item 9 and the
suppression/policy overlay in item 3, and neither gets built faster by also
building a sequencer.

If the owner selects Option A, this ADR must be amended with the evidence for
whichever of the three justifications applies, before items 7 and 8 begin.

## Consequences

**Under Option B:**

- Items 7 and 8 collapse to adapter work behind the existing
  `CampaignExecutionProvider` interface.
- The global suppression ledger (item 3) becomes *more* important, not less: it
  must be enforced by Upmax and honoured on every vendor touch, because vendor
  suppression is per-account and ours is cross-tenant.
- Item 2 scopes down: typecheck the send / suppression / tenancy / GHL path
  rather than burning 5–8 days across billing and white-label modules Release A
  does not need.
- We accept vendor dependency and their ToS, including white-label limits.
- `docs/PRODUCT-ARCHITECTURE.md:110` must be amended.

**Under Option A:**

- We own deliverability operations permanently: blocklist remediation, provider
  bans, Google Postmaster monitoring, mailbox replacement.
- Items 1, 3, 4 remain mandatory and unchanged.
- ADR-001's Go-extraction thresholds become relevant sooner.

**Under both:**

- Item 1 (schema), item 3 (compliance), item 4 (tenancy/RLS) and item 9
  (reply → appointment) are unchanged and mandatory.

## Validation

Whichever option is chosen, the decision is validated at the first controlled
send:

1. A `List-Unsubscribe` header and working one-click endpoint on every commercial
   email.
2. An atomic pre-send suppression check on the live send path.
3. One seed-list send where an opt-out is honoured and provably stops the next
   scheduled touch.

Revisit after the Release A pilot, or immediately if a vendor ToS change blocks
the white-label model.

## Leading indicator that this decision is being avoided

If a status report three weeks from now reads "type errors 1155 → 800" or "still
waiting on credentials" with no sender decision recorded here, the decision has
been made by default and the pilot date has moved.
