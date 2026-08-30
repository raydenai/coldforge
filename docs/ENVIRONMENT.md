# Environment Reference (FND-006)

`src/lib/env.ts` is the single source of truth for configuration. Every
`process.env` key the application reads is declared there exactly once, with its
requirement level. `src/instrumentation.ts` calls `validateEnv()` at server
startup: it **throws in production** so a misconfigured deployment fails at boot
rather than at the first request that touches a missing secret. In development
and test it warns and continues.

Failure messages contain key names and reasons only — never values.

## Two defects this surfaced

1. **`.env.production.template` declares `ENCRYPTION_KEY`, which no code reads.**
   `src/lib/encryption.ts` reads `ENCRYPTION_SECRET` and `ENCRYPTION_SALT`. A
   deployment configured from the template alone would fail at the first attempt
   to decrypt a stored credential.
2. **`ENCRYPTION_SALT` falls back to a hardcoded literal**
   (`'instantscale-default-salt'`, `src/lib/encryption.ts:15`). A predictable
   salt weakens every stored credential, so startup validation now requires the
   key in production.

`.env.production.template` still needs to be brought in line with the table
below; it is covered by a write-deny rule in this environment, so it was left
untouched rather than partially edited.

## Required — the app will not boot without these

| Key | Notes |
| --- | --- |
| `NODE_ENV` | `development` \| `test` \| `production` |
| `NEXT_PUBLIC_APP_URL` | must parse as a URL |
| `NEXT_PUBLIC_SUPABASE_URL` | must parse as a URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | public by design |

## Required in production only

| Key | Why |
| --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | server-side data access |
| `ENCRYPTION_SECRET` | credential encryption |
| `ENCRYPTION_SALT` | otherwise falls back to a predictable literal |
| `CRON_SECRET` | authorises `/api/cron/*` and `/api/email-queue/process` (7 call sites) |

## Refused in production

| Key | Why |
| --- | --- |
| `SMTP_ALLOW_SELF_SIGNED=true` | disables SMTP TLS certificate verification |
| `ALLOW_UNVERIFIED_WEBHOOKS=true` | accepts webhook requests without verifying their signature |

## Webhook verification (SEC-002)

Verification is **unconditional**. `src/lib/webhooks/verification.ts` is the
single policy all webhook routes use:

1. Verification always runs. No environment trusts a request by default.
2. A missing secret is a **misconfiguration (503), never a bypass**.
3. The only escape is `ALLOW_UNVERIFIED_WEBHOOKS=true`, which startup validation
   refuses in production.

Set the secret for every provider you actually receive webhooks from. An unset
secret now returns 503 rather than silently accepting traffic.

| Provider | Secret |
| --- | --- |
| internal email events | `EMAIL_WEBHOOK_SECRET` |
| SendGrid | `SENDGRID_WEBHOOK_VERIFICATION_KEY` |
| Postmark | `POSTMARK_WEBHOOK_TOKEN` |
| Stripe | `STRIPE_WEBHOOK_SECRET` |
| Slack | `SLACK_SIGNING_SECRET` |
| AWS SES / SNS | none — authenticated by signing certificate |

### Deprecated no-ops

`VERIFY_EMAIL_WEBHOOKS` · `VERIFY_SNS_SIGNATURES` · `VERIFY_SENDGRID_SIGNATURES`

These previously enabled verification outside production. Verification now
always runs, so they have no effect. They remain declared in the schema so an
existing deployment that still sets them validates cleanly.

### Behaviour change for internal senders

`/api/webhooks/email-events` now **requires** the `x-webhook-timestamp` header.
Previously a request without one was signed over the bare body and could be
replayed indefinitely. The signed payload is `` `${timestamp}.${rawBody}` `` and
the timestamp must be within 5 minutes. Any internal sender that omitted the
header must be updated.

## Feature-gated (optional)

Only required when the feature is used; the consuming adapter validates them, so
an unused integration never blocks boot.

- **Queue/cache** — `REDIS_URL`, `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `DATABASE_URL`
- **Billing** — `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and the six
  `STRIPE_{STARTER,GROWTH,SCALE}_{MONTHLY,YEARLY}` price IDs
- **AI** — `ANTHROPIC_API_KEY`
- **Google** — `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`,
  `GOOGLE_POSTMASTER_CLIENT_ID`, `GOOGLE_POSTMASTER_CLIENT_SECRET`,
  `GOOGLE_POSTMASTER_REFRESH_TOKEN`
- **Microsoft** — `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`,
  `MICROSOFT_TENANT_ID`, `MICROSOFT_REDIRECT_URI`
- **CRM** — `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`,
  `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET`
- **DNS/CDN** — `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ZONE_ID`,
  `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFRONT_DISTRIBUTION_ID`, `FASTLY_API_KEY`,
  `FASTLY_SERVICE_ID`, `BUNNY_API_KEY`, `BUNNY_PULL_ZONE_ID`
- **Observability** — `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_DEBUG`,
  `NEXT_PUBLIC_APP_VERSION`, `LOG_LEVEL`
- **Sending** — `TRACKING_BASE_URL`, `SMTP_ALLOW_SELF_SIGNED`
- **Toggles** — `ENABLE_JOB_QUEUE`, `ENABLE_REDIS_CACHE`, `ENABLE_RATE_LIMITING`,
  `ENABLE_CIRCUIT_BREAKER`, `ENABLE_METRICS`, `ENABLE_SHARDING`,
  `ANALYTICS_RETENTION_DAYS`
- **Internal** — `INTERNAL_API_KEY`, `NEXT_RUNTIME` (set by Next.js)

## Declared in the template but read nowhere

Setting these has no effect today. They are retained because the roadmap plans
the corresponding integrations.

`NAMECHEAP_API_USER` · `NAMECHEAP_API_KEY` · `NAMECHEAP_CLIENT_IP` ·
`PORKBUN_API_KEY` · `PORKBUN_SECRET_KEY` · `ZEROBOUNCE_API_KEY` (LEAD-004) ·
`STRIPE_PUBLISHABLE_KEY` · `GITHUB_WEBHOOK_SECRET`

## Adding a key

1. Declare it in the appropriate schema in `src/lib/env.ts`.
2. If it must exist in production, add it to `productionRequired`.
3. If it is unsafe in production, add it to `productionForbidden`.
4. Add a case to `tests/unit/lib/env.test.ts`.
5. Document it in `.env.production.template` and here.
