# Retained runtime environment

`src/lib/env.ts` defines startup validation. `src/instrumentation.ts` validates
at startup and throws for invalid production configuration; development/test
warn and continue. Validation messages identify keys, never secret values.
The schema still declares historical optional integrations; a declaration alone
does not mean its retired runtime route exists.

## Required configuration

| Key | Requirement and purpose |
|---|---|
| NODE_ENV | production for deployment |
| NEXT_PUBLIC_APP_URL | Valid public application URL; signed unsubscribe links and webhook receiver URLs use this origin |
| NEXT_PUBLIC_SUPABASE_URL | Valid project URL |
| NEXT_PUBLIC_SUPABASE_ANON_KEY | Public browser key; authorization still requires RLS and authenticated membership |
| SUPABASE_SERVICE_ROLE_KEY | Required in production; private server-only repositories |
| ENCRYPTION_SECRET | Required in production; credential encryption and unsubscribe signing |
| ENCRYPTION_SALT | Required in production and for every new encrypted credential |
| CRON_SECRET | Required in production; authenticated outreach scheduler and downstream cron |

Keep ENCRYPTION_SECRET and ENCRYPTION_SALT stable and backed up securely.
`src/lib/encryption.ts` derives an AES-256-GCM key with scrypt. New encryption
refuses a missing salt. Decryption alone tries the former hardcoded salt as a
compatibility fallback and warns when used; re-encrypt those historical records
with the configured salt. Changing either value can make stored credentials
unreadable; changing ENCRYPTION_SECRET also invalidates signed unsubscribe tokens.
`ENCRYPTION_KEY` is not read and is not a substitute for these two keys.

## Organization-specific provider setup

Winnr tokens are validated and encrypted in020 storage. SMTP credentials imported
through026 are encrypted and bound to the current organization, connection,
version and mailbox.027 receiver signing secrets are generated/stored per endpoint;
configure the returned receiver URL and secret with Winnr. A configured association
is not proof that a live callback or SMTP delivery has occurred.

030 stores the selected Anthropic model and API key in encrypted organization
configuration. Its adapter uses that stored key, not a global ANTHROPIC_API_KEY
as an automatic fallback. Briefs, policy and approved immutable decisions govern
automated replies; configuration alone does not authorize an effect.

033 similarly stores GHL, CloseBot and Retell credentials encrypted per organization,
with provider-specific nonsecret settings. Configure these through the pipeline
setup. Callback/voice eligibility is a separate explicit operator record; a saved
phone number, model decision or inbound message does not establish call consent.
Webhook authentication uses provider-specific contracts and stored configuration;
see [downstream contracts](OUTREACH-DOWNSTREAM-CONTRACTS.md). No global GHL/Retell/
CloseBot environment token or retired generic integration route is required.

Lead validation uses retained server-side provider configuration where requested;
validation provenance must match the current email and freshness gate. Synthetic
fixture evidence is not production validation.

## Optional and refused settings

SENTRY_DSN, NEXT_PUBLIC_SENTRY_DSN, SENTRY_DEBUG, NEXT_PUBLIC_APP_VERSION and
LOG_LEVEL configure observability. NEXT_PUBLIC_* values are public at build time;
never put provider credentials in them.

Production refuses SMTP_ALLOW_SELF_SIGNED=true and ALLOW_UNVERIFIED_WEBHOOKS=true.
Retained SMTP requires certificate verification; retained ingestion/downstream
webhooks do not gain a signature bypass from historical toggles.

Legacy OAuth callbacks, local warmup/queue workers, billing/registrar routes and
old provider webhook surfaces were retired. Their historical optional env keys
remain in the schema for compatibility and do not recreate those routes. Redis,
Stripe, registrar and Google/Microsoft OAuth settings are not prerequisites for
the retained email-first flow.

## Test fixture environment

The PostgreSQL release runner requires every guarded local fixture URL explicitly,
strips inherited PG* variables and rejects other hosts/ports/database names.
See [migration runbook](OUTREACH-MIGRATION-RUNBOOK.md). Never use production
credentials or a production DATABASE_URL for those disposable test targets.
