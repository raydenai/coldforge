# ColdForge

Email-first outreach over Winnr: mailbox readiness and warm-up controls, lead
import and validation, campaign sequences, a shared reply inbox, approved AI
copy and conversation decisions, qualification, booking and requested callbacks.
The Operations screen exposes setup gaps, held actions and the outbound stop.
Social and LinkedIn adapters are future modules.

## Local development

Use Node24 and PostgreSQL17 for the database integration tests.

```sh
npm ci
cp .env.production.template .env.local
npm run dev
```

Set real development configuration in the ignored `.env.local` before starting.
The application runs at http://localhost:4000. Never commit credentials or point
disposable integration fixtures at a live database.

[Environment setup](docs/ENVIRONMENT.md) describes required variables and encrypted
organization-specific providers. [Authentication setup](docs/AUTH-STARTUP.md)
covers signup confirmation and redirect URLs.

## Verification and release

```sh
npm run lint
npm run typegen
npm run typecheck
npm run test:unit
npm run build
```

The [migration runbook](docs/OUTREACH-MIGRATION-RUNBOOK.md) specifies all16 guarded
local PostgreSQL targets and the required integration runner. The live historical
schema requires additive migrations020–033; do not replay incompatible001–019.
Release through a feature-branch pull request with CI and a verified backup.

## Operating the system

1. Connect Winnr and configure actual sender domains, mailboxes and ingestion.
2. Import leads, verify current email addresses, and assign ready senders to a campaign.
3. Approve campaign copy and scheduling; monitor replies, suppression and receipts.
4. Configure a model and approved knowledge before enabling conversation automation.
5. Configure GHL, CloseBot or Retell in Pipeline when those accounts are available.

SMTP acceptance is distinct from delivery. Unknown provider outcomes remain held
for verified reconciliation. Inbound replies stop cold follow-ups; human takeover
stops agent replies. Voice callbacks require a separate eligibility record.
See [downstream contracts](docs/OUTREACH-DOWNSTREAM-CONTRACTS.md),
[implementation plan](docs/superpowers/plans/2026-10-05-complete-outreach.md) and
[release state](docs/QUEEN-STATE.yaml) for scope and measured evidence.
