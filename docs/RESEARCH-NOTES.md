# Research Notes and Product Decisions

Research date: 2026-08-22. Vendor claims should be validated with test accounts and contracts before production reliance.

## Winnr

Published capabilities include REST API coverage for domains, mailboxes, warming, inboxes, exports, and jobs; domain purchase/connect; bulk mailbox creation; SMTP/IMAP; DNS authentication; and infrastructure health.

- https://winnr.app/help/api-mcp/api-intro.html
- https://winnr.app/help/getting-started/what-is-winnr.html
- https://winnr.app/help/getting-started/choose-plan.html

Decision: use Winnr as the email-infrastructure provider and retain a provider abstraction.

## Smartlead

Smartlead's documented API covers campaigns, leads, email accounts, sequences, analytics, warmup, and webhooks for sent/opened/clicked/replied/bounced/unsubscribed events.

- https://api.smartlead.ai/core/webhooks
- https://helpcenter.smartlead.ai/en/articles/125-full-api-documentation

Decision: use as a feature/parity benchmark and optional migration fallback, not the primary runtime.

## Miss Pepper

The referenced model coordinates lead routing, enrichment, email, social, text, voice, AI reply classification, calendar booking, CRM synchronization, human approval for risky touches, and bring-your-own infrastructure.

- https://misspepper.ai/sales-automation/

Decision: reproduce the outcome and control model in stages. Prove email-to-appointment before ads/social expansion.

## HighLevel

GHL exposes contacts, conversations, calendars, opportunities, payments, and broad webhooks. It supports adding inbound email/custom messages and a custom conversation provider whose outbound events can be delivered to Upmax. Current webhook security uses `X-GHL-Signature` Ed25519.

- https://marketplace.gohighlevel.com/docs/
- https://marketplace.gohighlevel.com/docs/ghl/conversations/add-an-inbound-message/
- https://marketplace.gohighlevel.com/docs/2023-02-21/marketplace-modules/ConversationProviders/
- https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide/
- https://marketplace.gohighlevel.com/docs/ghl/calendars/calendar-events/

Decision: GHL is the CRM, conversation timeline, opportunity, and appointment system of record.

## CloseBot

CloseBot connects to GHL/HubSpot and custom webhook sources, qualifies leads, uses gated agent tools, and conversationally books/reschedules against GHL calendars.

- https://docs.closebot.com/en/articles/11107781-1-sources
- https://docs.closebot.com/en/articles/12822480-agent-tools
- https://docs.closebot.com/en/articles/11594749-booking
- https://docs.closebot.com/en/articles/16358483-custom-blank-source-channel-webhook

Decision: use CloseBot for text qualification and booking while Upmax retains routing, policy, audit, and send authority.

## Retell AI

Retell provides voice/chat agents, signed webhooks, function tools, calendar integrations, SDKs, QA/testing, and an MCP server. Retell documentation warns that production function calls require duplicate-call and state controls.

- https://docs.retellai.com/features/webhook-overview
- https://docs.retellai.com/build/custom-function
- https://docs.retellai.com/build/book-calendar
- https://docs.retellai.com/get-started/mcp-server

Decision: start with inbound, requested callbacks, appointment confirmation, and policy-approved no-show recovery—not unrestricted cold AI calling.

## Lead data and validation

Apollo supports filtered people search plus people/company enrichment; search results require enrichment to reveal contact data. ZeroBounce returns explicit valid, invalid, catch-all, unknown, spamtrap, abuse, and do-not-mail states.

- https://docs.apollo.io/reference/people-api-search
- https://docs.apollo.io/reference/people-enrichment
- https://www.zerobounce.net/docs/email-validation-api-quickstart/v2-validate-emails

Decision: Apollo and ZeroBounce are initial adapters with provenance and cost controls; CSV and GHL imports remain first-class.

## Compliance constraints

The FTC states CAN-SPAM applies to B2B commercial email and requires accurate identity, non-deceptive subjects, postal address, clear opt-out, and honoring opt-outs. FTC/FCC guidance restricts prerecorded/AI telemarketing and robotexts; DNC and consent policy must be reviewed for each use case and jurisdiction.

- https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business
- https://www.ftc.gov/business-guidance/advertising-marketing/telemarketing
- https://www.ftc.gov/business-guidance/resources/qa-telemarketers-sellers-about-dnc-provisions-tsr-0
- https://docs.fcc.gov/public/attachments/DOC-404036A1.pdf

Decision: compliance is an executable policy engine plus legal approval gate, not a checkbox or vendor assumption.

## Claude Code and Queen orchestration

Claude Code currently supports subagents, agent view, experimental agent teams, worktree isolation, hooks that can block task completion, skills, MCP, non-interactive runs, permission modes, and scheduled routines.

- https://code.claude.com/docs/en/agents
- https://code.claude.com/docs/en/agent-teams
- https://code.claude.com/docs/en/worktrees
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/features-overview
- https://code.claude.com/docs/en/permission-modes
- https://code.claude.com/docs/en/headless
- https://code.claude.com/docs/en/scheduled-tasks

Ruflo/Claude-Flow publishes queen-led hierarchical swarm concepts, but it is not required for the first implementation.

- https://github.com/ruvnet/claude-flow
- https://github.com/ruvnet/ruflo/blob/main/v3/%40claude-flow/swarm/README.md

Decision: implement the Queen Protocol with native Claude Code primitives first; evaluate Ruflo after the production foundation is stable.

## Runtime and language policy

Node.js recommends LTS lines for production; Node 24 is the current LTS on the research date. Next.js 16 requires Node 20.9 or newer. Go 1.27 was released only three days before this research, while Go 1.26.7 remains supported. Rust's ownership/type system provides strong memory and concurrency safety, but does not remove business-logic or distributed-systems failures.

- https://nodejs.org/en/about/previous-releases
- https://nextjs.org/docs/app/getting-started/installation
- https://go.dev/doc/devel/release
- https://doc.rust-lang.org/book/ch16-00-concurrency.html

Decision: Node 24 LTS/TypeScript for Release A; Go for measured service extraction; Rust for exceptional measured hotspots. Do not rewrite the existing product before proving the end-to-end funnel.
