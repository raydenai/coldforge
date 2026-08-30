/**
 * Environment schema and startup validation (FND-006).
 *
 * Every `process.env` key the application reads is declared here exactly once,
 * with its requirement level. The goal is that a misconfigured deployment fails
 * at boot with a precise message, rather than at the first request that happens
 * to touch an absent secret.
 *
 * Requirement levels:
 *   - always required: the app cannot serve a request without it.
 *   - required in production: safe to omit locally, must be present in prod.
 *   - feature-gated: only required when the feature it powers is used. These are
 *     optional here and validated by the adapter that consumes them, so an
 *     unused integration never blocks boot.
 *
 * Values are NEVER logged. Errors report key names and reasons only.
 */

import { z } from 'zod'

const nonEmpty = (label: string) => z.string().trim().min(1, `${label} must not be empty`)

/** `"true"` enables; anything else (including absent) disables. */
const boolFlag = z
  .string()
  .optional()
  .transform((v) => v === 'true')

const url = (label: string) => nonEmpty(label).url(`${label} must be a valid URL`)

/**
 * Keys that are safe to expose to the browser. Next.js inlines `NEXT_PUBLIC_*`
 * at build time, so these must never hold secrets.
 */
const clientSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: url('NEXT_PUBLIC_SUPABASE_URL'),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: nonEmpty('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
  NEXT_PUBLIC_APP_URL: url('NEXT_PUBLIC_APP_URL'),
  NEXT_PUBLIC_SENTRY_DSN: z.string().optional(),
  NEXT_PUBLIC_APP_VERSION: z.string().optional(),
})

const serverSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  NEXT_RUNTIME: z.enum(['nodejs', 'edge']).optional(),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // --- Data plane -------------------------------------------------------
  // Required in production; see productionRequired below.
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  DATABASE_URL: z.string().optional(),

  // --- Secrets ----------------------------------------------------------
  // ENCRYPTION_SALT has a hardcoded fallback in src/lib/encryption.ts. A
  // predictable salt weakens every stored credential, so production must set it.
  ENCRYPTION_SECRET: z.string().optional(),
  ENCRYPTION_SALT: z.string().optional(),
  CRON_SECRET: z.string().optional(),
  INTERNAL_API_KEY: z.string().optional(),

  // --- Queue / cache ----------------------------------------------------
  REDIS_URL: z.string().optional(),
  REDIS_HOST: z.string().optional(),
  REDIS_PORT: z.coerce.number().int().positive().optional(),
  REDIS_PASSWORD: z.string().optional(),

  // --- Webhook verification --------------------------------------------
  // Verification is unconditional (SEC-002). The only escape is an explicit
  // opt-in, which productionForbidden refuses in production.
  ALLOW_UNVERIFIED_WEBHOOKS: boolFlag,

  // DEPRECATED no-ops. These used to enable verification outside production;
  // verification now always runs, so setting them has no effect. Declared so a
  // deployment that still sets them validates cleanly rather than failing on an
  // unknown key.
  VERIFY_EMAIL_WEBHOOKS: boolFlag,
  VERIFY_SNS_SIGNATURES: boolFlag,
  VERIFY_SENDGRID_SIGNATURES: boolFlag,

  EMAIL_WEBHOOK_SECRET: z.string().optional(),
  SENDGRID_WEBHOOK_VERIFICATION_KEY: z.string().optional(),
  POSTMARK_WEBHOOK_TOKEN: z.string().optional(),
  SLACK_SIGNING_SECRET: z.string().optional(),

  // --- Billing (feature-gated) -----------------------------------------
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_STARTER_MONTHLY: z.string().optional(),
  STRIPE_STARTER_YEARLY: z.string().optional(),
  STRIPE_GROWTH_MONTHLY: z.string().optional(),
  STRIPE_GROWTH_YEARLY: z.string().optional(),
  STRIPE_SCALE_MONTHLY: z.string().optional(),
  STRIPE_SCALE_YEARLY: z.string().optional(),

  // --- AI (feature-gated) ----------------------------------------------
  ANTHROPIC_API_KEY: z.string().optional(),

  // --- OAuth / mailbox providers (feature-gated) ------------------------
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().optional(),
  GOOGLE_POSTMASTER_CLIENT_ID: z.string().optional(),
  GOOGLE_POSTMASTER_CLIENT_SECRET: z.string().optional(),
  GOOGLE_POSTMASTER_REFRESH_TOKEN: z.string().optional(),
  MICROSOFT_CLIENT_ID: z.string().optional(),
  MICROSOFT_CLIENT_SECRET: z.string().optional(),
  MICROSOFT_TENANT_ID: z.string().optional(),
  MICROSOFT_REDIRECT_URI: z.string().optional(),

  // --- CRM integrations (feature-gated) ---------------------------------
  HUBSPOT_CLIENT_ID: z.string().optional(),
  HUBSPOT_CLIENT_SECRET: z.string().optional(),
  SALESFORCE_CLIENT_ID: z.string().optional(),
  SALESFORCE_CLIENT_SECRET: z.string().optional(),

  // --- CDN / DNS (feature-gated) ----------------------------------------
  CLOUDFLARE_API_TOKEN: z.string().optional(),
  CLOUDFLARE_ZONE_ID: z.string().optional(),
  CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
  CLOUDFRONT_DISTRIBUTION_ID: z.string().optional(),
  FASTLY_API_KEY: z.string().optional(),
  FASTLY_SERVICE_ID: z.string().optional(),
  BUNNY_API_KEY: z.string().optional(),
  BUNNY_PULL_ZONE_ID: z.string().optional(),

  // --- Observability ----------------------------------------------------
  SENTRY_DSN: z.string().optional(),
  SENTRY_DEBUG: boolFlag,

  // --- Sending ----------------------------------------------------------
  TRACKING_BASE_URL: z.string().optional(),
  // Disables TLS certificate checking on SMTP connections. Refused in
  // production by productionForbidden below.
  SMTP_ALLOW_SELF_SIGNED: boolFlag,

  // --- Feature toggles --------------------------------------------------
  ENABLE_JOB_QUEUE: boolFlag,
  ENABLE_REDIS_CACHE: boolFlag,
  ENABLE_RATE_LIMITING: boolFlag,
  ENABLE_CIRCUIT_BREAKER: boolFlag,
  ENABLE_METRICS: boolFlag,
  ENABLE_SHARDING: boolFlag,
  ANALYTICS_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
})

/** Server keys that must be present when NODE_ENV=production. */
const productionRequired = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'ENCRYPTION_SECRET',
  'ENCRYPTION_SALT',
  'CRON_SECRET',
] as const

/** Server flags that must NOT be enabled when NODE_ENV=production. */
const productionForbidden = [
  { key: 'SMTP_ALLOW_SELF_SIGNED', reason: 'disables SMTP TLS certificate verification' },
  {
    key: 'ALLOW_UNVERIFIED_WEBHOOKS',
    reason: 'accepts webhook requests without verifying their signature',
  },
] as const

export type ClientEnv = z.infer<typeof clientSchema>
export type ServerEnv = z.infer<typeof serverSchema>

export interface EnvProblem {
  key: string
  reason: string
}

export interface EnvValidationResult {
  ok: boolean
  problems: EnvProblem[]
}

/**
 * Validate an environment bag without throwing.
 *
 * Accepts the source explicitly so this is testable without mutating
 * `process.env`.
 */
export function checkEnv(source: Record<string, string | undefined>): EnvValidationResult {
  const problems: EnvProblem[] = []

  const client = clientSchema.safeParse(source)
  if (!client.success) {
    for (const issue of client.error.issues) {
      problems.push({ key: String(issue.path[0] ?? '(root)'), reason: issue.message })
    }
  }

  const server = serverSchema.safeParse(source)
  if (!server.success) {
    for (const issue of server.error.issues) {
      problems.push({ key: String(issue.path[0] ?? '(root)'), reason: issue.message })
    }
  }

  const isProduction = source.NODE_ENV === 'production'

  if (isProduction) {
    for (const key of productionRequired) {
      const value = source[key]
      if (value === undefined || value.trim() === '') {
        problems.push({ key, reason: 'required when NODE_ENV=production' })
      }
    }

    for (const { key, reason } of productionForbidden) {
      if (source[key] === 'true') {
        problems.push({ key, reason: `must not be enabled in production: ${reason}` })
      }
    }
  }

  return { ok: problems.length === 0, problems }
}

/**
 * Validate `process.env` at startup.
 *
 * Throws in production so a misconfigured deployment fails fast and visibly.
 * In development and test it reports problems and lets the process continue, so
 * a partially configured machine can still run unrelated work.
 */
export function validateEnv(source: Record<string, string | undefined> = process.env): void {
  const { ok, problems } = checkEnv(source)

  if (ok) return

  // Key names and reasons only — never values.
  const report = problems.map((p) => `  - ${p.key}: ${p.reason}`).join('\n')
  const message = `Environment validation failed (${problems.length} problem${
    problems.length === 1 ? '' : 's'
  }):\n${report}`

  if (source.NODE_ENV === 'production') {
    throw new Error(message)
  }

  console.warn(`[env] ${message}`)
}
