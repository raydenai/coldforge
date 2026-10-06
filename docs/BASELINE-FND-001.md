# FND-001 — Verified Baseline

Reproduced on 2026-08-22 against `docs/upmax-queen-production-roadmap` @ `79801a0`
(1 commit ahead of `origin/main` @ `f55ecef`; 0 behind).

Environment: macOS (darwin 25.3.0), Node **v22.23.1** (roadmap target is Node 24 LTS — see FND-013),
npm workspace already installed, Supabase CLI 2.113.0, Docker running.

## Gate results

| Gate | Command | Result |
|---|---|---|
| Unit tests | `npm run test:run` | **312 passed, 9 failed** (321 total, 13 files) |
| Lint | `npm run lint` | **38 errors, 172 warnings** across 497 files |
| Typecheck | `npx tsc --noEmit` | **Crashes** — `RangeError: Map maximum size exceeded` |
| Build | `npm run build` | Blocked by the typecheck crash |
| `typecheck` script | — | **Does not exist** in `package.json` (FND-008) |
| `test:integration` / `test:e2e` scripts | — | **Do not exist** (FND-008) |
| CI | `.github/workflows` | **No workflows present** |
| `engines` / `.nvmrc` | — | **Absent** — Node version is unpinned (FND-013) |

## Test failures (9) — all in `tests/unit/lib/errors.test.ts`

Cause: the test file encodes a different error contract than `src/lib/errors/index.ts`.

| Test expectation | Implementation |
|---|---|
| `error.context` | `error.details` |
| `AuthenticationError.code = 'AUTH_ERROR'` | `'AUTHENTICATION_ERROR'` |
| `AuthorizationError` → `'Permission denied'` / `'FORBIDDEN'` | `'Access denied'` / `'AUTHORIZATION_ERROR'` |
| `new NotFoundError()` (no args) | `resource` was a required parameter |
| `RateLimitError` → `'Rate limit exceeded'` | `'Too many requests'` |
| `new ExternalServiceError(service, Error)` | `(service, message: string, details?)` |

## Lint breakdown

Errors (38): `@typescript-eslint/no-explicit-any` 14 · `prefer-const` 13 ·
`@typescript-eslint/no-require-imports` 4 · `react/no-unescaped-entities` 3 ·
`react-hooks/set-state-in-effect` 3 · `react-hooks/rules-of-hooks` 1.

Warnings (172): `@typescript-eslint/no-unused-vars` 163 · `react-hooks/exhaustive-deps` 9.

## Typecheck crash — root cause (FND-004)

Bisected by generated per-directory `tsconfig` probes:

```
src/lib                     CRASH  69s
src/lib/a*|b*|c*|d*         CRASH  59s
src/lib/billing             CRASH  54s
src/lib/billing/invoices.ts CRASH  54s   <- single-file reproduction
```

`src/lib/billing/invoices.ts` issues 13 queries against `invoices`,
`invoice_line_items` and `billing_events`. **`invoices` and `invoice_line_items`
are absent from the generated `src/types/database.ts`**, so every
`supabase.from('invoices')` falls through to the `relation: never` overload. The
resulting `PostgrestQueryBuilder<…, never, never, never>` combined with
`.select('*, invoice_line_items (*)')` string-parsing conditional types makes the
type-relation cache exceed V8's Map limit (2^24 entries).

The crash is a symptom. The defect is schema/type drift.

## Schema drift (root defect behind FND-004)

`supabase/migrations/*.sql` declares **112** tables. `src/types/database.ts`
declares **98**. They are not subsets of each other.

**25 tables have migrations but no generated types** — including `invoices`,
`invoice_line_items`, `coupons`, `coupon_redemptions`, `usage_records`,
`audit_logs`, `analytics_events`, `daily_metrics`, `dead_letter_queue`,
`dkim_keys`, `domain_dns_records`, `domain_health_checks`, `domain_purchases`,
`email_opens`, `email_tracking_links`, `sender_reputation`, and 5 `warmup_*` tables.

**11 tables have generated types but no DDL anywhere in the repository** — not in
`supabase/migrations/`, not in `supabase/SETUP_SUPABASE_CLOUD.sql`. The
application queries them **234 times**:

| Table | `from()` call sites |
|---|---|
| `workspace_members` | 75 |
| `profiles` | 57 |
| `mailboxes` | 33 |
| `email_jobs` | 21 |
| `workspaces` | 12 |
| `organization_members` | 6 |
| `lead_tags` | 5 |
| `inbox_messages` | 4 |
| `subscriptions` | 4 |
| `sync_states` | 4 |
| `credit_packages` | 3 |

Consequence: a clean checkout provisioned from `supabase/migrations/` yields a
database in which a large share of the application's queries fail at runtime.
`src/types/database.ts` has been hand-maintained, so the type checker cannot
detect this.

## Migrations do not apply from scratch

`supabase start` against a clean local Postgres 15.8.1 fails at migration 007:

```
Applying migration 001_initial_schema.sql ... 006_auto_create_org.sql   OK
Applying migration 007_warmup_pool.sql
ERROR: relation "warmup_emails" already exists (SQLSTATE 42P07)
```

Two tables are created twice by the migration set:

| Table | Created in |
|---|---|
| `warmup_emails` | `001_initial_schema.sql`, `007_warmup_pool.sql` |
| `warmup_schedules` | `007_warmup_pool.sql`, `010_smtp_infrastructure.sql` |

The migration set has therefore never been applied as a set — the live database was
provisioned by some other path. Until this is reconciled, `supabase db reset`,
disposable-database integration tests (FND-009) and migration validation (FND-011)
are all unreachable.

Reconciliation is deferred to the live-schema epic rather than guessed at: editing
already-applied migrations is not safe without knowing what the live database
actually contains.

## Competing tenancy models

Two mutually incompatible tenancy models are both live on the production path:

- `organizations` / `organization_members` — real DDL in `001_initial_schema.sql`; 17 call sites.
- `workspaces` / `workspace_members` — **no DDL anywhere**; 87 call sites.

They are split across API routes by accident of authorship, not by design:

- `src/app/api/warmup/{reputation,ramp,orchestrator}/route.ts` authorize against `organization_members`.
- `src/app/api/{reputation/*,integrations/*,smtp-providers/*,email-queue,oauth/authorize}/route.ts` authorize against `workspace_members`.

This is a tenant-isolation correctness issue, not only a naming inconsistency.
Resolving it requires an owner decision and an ADR.

## Reproduction commands

```bash
npm run test:run
npm run lint
npx tsc --noEmit                       # crashes
npx tsc -p <probe>.json --noEmit       # per-directory bisect
```
