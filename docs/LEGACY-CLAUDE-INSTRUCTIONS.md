# ColdForge - Cold Email Outreach Platform

> **Cross-Reference**: This file is mirrored across `CLAUDE.md`, `AGENTS.md`, and `GEMINI.md` so the same instructions load in any AI environment.

---

## Overview

ColdForge is a full-featured cold email outreach platform combining Instantly.ai's campaign management with Mailscale.ai's infrastructure automation. Multi-tenant SaaS for agencies and power users who need to send 10,000-100,000 emails/day with maximum deliverability.

**Core Value**: Automated infrastructure + intelligent sending = inbox placement at scale.

---

## 3-Layer Agent Architecture (DOE Framework)

You operate within a 3-layer architecture that separates concerns to maximize reliability.

### Layer 1: Directive (What to do)
- SOPs written in Markdown, live in `directives/`
- Define goals, inputs, outputs, and edge cases
- **Each directive has YAML front matter** with `name`, `description`, and `scripts` fields

### Layer 2: Orchestration (Decision making)
- This is you. Your job: intelligent routing.
- Read directives, call execution tools in the right order, handle errors, ask for clarification
- You're the glue between intent and execution

### Layer 3: Execution (Doing the work)
- Deterministic Python/TypeScript scripts in `execution/`
- Handle API calls, data processing, file operations
- Reliable, testable, fast. Use scripts instead of manual work.

---

## Quick Start

```bash
# Development
npm run dev          # http://localhost:3000

# Testing
npm run test         # Run all tests
npm run test:watch   # Watch mode
```

---

## Directory Structure

```
instantly-clone/
├── .planning/           # Project planning (GSD)
│   ├── PROJECT.md       # Vision and requirements
│   ├── ROADMAP.md       # Phase breakdown
│   ├── STATE.md         # Cross-session memory
│   └── phases/          # Phase plans
│
├── directives/          # SOP markdown files
│   ├── _template.md     # Template for new directives
│   ├── domain_setup.md  # Auto domain purchase + DNS
│   ├── mailbox_setup.md # Email account creation
│   ├── warmup.md        # Email warmup system
│   ├── campaign.md      # Campaign management
│   └── deliverability.md # Inbox placement strategies
│
├── execution/           # Execution scripts
│   ├── purchase_domain.py
│   ├── setup_dns.py
│   ├── create_mailbox.py
│   ├── warmup_account.py
│   ├── send_campaign.py
│   └── check_deliverability.py
│
├── .tmp/                # Ephemeral intermediate files
│   └── (auto-cleaned)
│
├── config/              # Credentials (git-ignored)
│   ├── namecheap.json
│   ├── cloudflare.json
│   └── google_workspace.json
│
├── src/                 # Next.js application
│   ├── app/             # App router
│   ├── components/      # React components
│   └── lib/             # Utilities
│
├── supabase/            # Database migrations
└── tests/               # Test suite
```

---

## Operating Principles

### 1. Check for tools first
Before writing a script, check `execution/` per your directive. Only create new scripts if none exist.

### 2. Self-anneal when things break
- Read error message and stack trace
- Fix the script and test it again
- Update the directive with what you learned
- System is now stronger

### 3. Update directives as you learn
Directives are living documents. When you discover API constraints, better approaches, common errors, or timing expectations—update the directive.

---

## Available Directives

| Directive | Purpose | Scripts |
|-----------|---------|---------|
| `domain_setup.md` | Auto domain purchase + DNS configuration | `purchase_domain.py`, `setup_dns.py` |
| `mailbox_setup.md` | Create email accounts (Google/Microsoft) | `create_mailbox.py` |
| `warmup.md` | Email warmup system | `warmup_account.py` |
| `campaign.md` | Campaign creation and sending | `send_campaign.py` |
| `deliverability.md` | Inbox placement strategies | `check_deliverability.py` |

---

## API Integrations

| Service | Purpose | Credentials |
|---------|---------|-------------|
| Namecheap | Domain registration | `config/namecheap.json` |
| Cloudflare | DNS management | `config/cloudflare.json` |
| Google Workspace | Mailbox creation | `config/google_workspace.json` |
| Microsoft 365 | Mailbox creation | `config/microsoft.json` |
| Supabase | Database | `.env.local` |

---

## Self-Annealing Error Loop

```
Error Occurs → Pattern Match → Auto-Fix → Learn → Update Directive
```

When something breaks:
1. Fix it
2. Update the execution script
3. Test the script
4. Update directive with new flow
5. System is now stronger

---

## Deliverability Best Practices

Based on `DELIVERABILITY_STRATEGY.md`:

1. **Domain Hygiene**: New domains need 2-4 weeks warmup
2. **Sending Patterns**: Human-like scheduling (not robotic)
3. **Content Quality**: Avoid spam trigger words
4. **Technical Setup**: SPF, DKIM, DMARC, BIMI
5. **Engagement**: Encourage replies, track opens carefully

---

## Tech Stack

- **Frontend**: Next.js 14, TypeScript, Tailwind CSS, shadcn/ui
- **Backend**: Supabase (PostgreSQL + Edge Functions)
- **Email**: SMTP/IMAP, Google Workspace API, Microsoft Graph API
- **DNS**: Cloudflare API, Namecheap API
- **Testing**: Vitest

---

## Key Files

- `/.planning/PROJECT.md` - Full project vision
- `/.planning/ROADMAP.md` - Development phases
- `/DELIVERABILITY_STRATEGY.md` - Email deliverability guide
- `/src/` - Application source code
- `/supabase/` - Database schema
