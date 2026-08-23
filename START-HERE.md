# Upmax AI Outreach — Claude Code Execution Package

This package converts the current ColdForge repository into a production program run by a Claude Code CTO/Project Owner (the **Queen**) with isolated parallel implementation agents (the **sidecars**).

## Product decision

Build **Upmax AI Outreach** as the orchestration layer instead of rebuilding commodity infrastructure:

- **Winnr** owns domains, DNS authentication, mailboxes, SMTP/IMAP, warming, and infrastructure health.
- **ColdForge / Upmax** owns lead intake, validation, campaigns, sequencing, safety, reply routing, analytics, tenant isolation, and the operator UI.
- **GoHighLevel (GHL)** owns CRM contacts, opportunities, pipeline state, conversations, calendars, and appointment records.
- **CloseBot** owns qualified text conversations and conversational appointment booking.
- **Retell AI** owns voice calls for opted-in, inbound, warm, or otherwise legally approved use cases.
- **Apollo + ZeroBounce** are the first lead-data and email-validation providers, behind replaceable interfaces.
- **Smartlead** is a parity benchmark and temporary fallback, not a permanent runtime dependency.

## Technology decision

- **TypeScript + Node.js 24 LTS + Next.js** remain the Release A product/control plane. This preserves the existing application and has the best SDK fit for Winnr, GHL, CloseBot, Retell, Stripe, Supabase, and the UI.
- **Go** is the preferred language for extracted high-concurrency workers, webhook gateways, reconcilers, or operational CLIs after profiling proves a need.
- **Rust** is reserved for security-critical parsers, cryptography, or CPU/memory hotspots where benchmarks show a meaningful advantage.

This is a governed modular-monolith-first architecture. A rewrite or premature microservices split would delay the working replacement without improving customer outcomes. See `docs/ADR-001-TECHNOLOGY-STACK.md`.

## Two release targets

### Release A — Replace Mailscale + Instantly

Target: a controlled production pilot in **4–6 focused weeks**.

It must provision/connect Winnr mailboxes, import and validate leads, execute safe sequences, ingest replies, stop sequences immediately, synchronize GHL, and book appointments through CloseBot/GHL.

### Release B — Miss-Pepper-style Upmax system

Target: **8–12 weeks** after Release A begins, depending on provider approvals and production evidence.

It adds scoring/enrichment, coordinated SMS and consented voice, no-show recovery, richer analytics, client workspaces, and controlled multi-channel orchestration. Paid ads and social DMs are later extensions, not Release A blockers.

## Install this package into the ColdForge repository

Copy these files into the root of a clean ColdForge checkout, preserving paths:

- `CLAUDE.md`
- `.claude/`
- `.worktreeinclude`
- `docs/`
- `BOOTSTRAP-PROMPT.md`

Then:

1. Install and authenticate Claude Code.
2. Run `claude --version`; agent teams require a current version.
3. Add provider credentials only to local/managed secret stores. Never commit them.
4. Start Claude Code from the repository root.
5. Paste the contents of `BOOTSTRAP-PROMPT.md`.

Use Claude Code `auto` mode only where its safety checks are available. Do not use `bypassPermissions` on the host machine. CI sidecars should use `dontAsk` with explicit allowlists.

## Required human gates

The Queen can operate autonomously between gates, but it must pause for:

- purchases or paid-plan changes;
- production secrets or OAuth authorization;
- production migrations or irreversible data changes;
- sending real outreach or placing real calls;
- legal/compliance policy decisions;
- production deployment, DNS cutover, or customer data import;
- changes to price, positioning, or target customer.

That is low-monitor autonomous development—not unsafe, unaccountable automation.

## Read next

1. `docs/PRODUCT-ARCHITECTURE.md`
2. `docs/GOALS-AND-METRICS.md`
3. `docs/ADR-001-TECHNOLOGY-STACK.md`
4. `docs/PRODUCTION-ROADMAP.md`
5. `docs/EXECUTION-BACKLOG.md`
6. `docs/AUTONOMY-RUNBOOK.md`
