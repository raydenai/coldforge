/**
 * Webhook verification policy (SEC-002).
 *
 * The constitution's invariant is: "Webhooks fail closed when verification
 * secrets are absent." Before this module, two routes did the opposite —
 * `if (secret) { verify }` — so deleting a secret silently disabled
 * authentication on an endpoint that mutates lead state.
 *
 * The policy here is deliberately narrow:
 *
 *   1. Verification is ALWAYS required. There is no environment in which a
 *      request is trusted by default.
 *   2. A missing secret is a MISCONFIGURATION (503), never a bypass. This is
 *      the whole point: absence of a secret must never widen access.
 *   3. The only way to accept unverified traffic is an explicit, deliberate
 *      opt-in (`ALLOW_UNVERIFIED_WEBHOOKS=true`) that is refused in production
 *      by startup validation (see src/lib/env.ts).
 *
 * Callers get a discriminated union so the "verify" branch carries a
 * non-optional secret and TypeScript enforces that the other branches return.
 */

import { createHash, timingSafeEqual } from 'node:crypto'

/** How a route should proceed for an inbound webhook request. */
export type WebhookDecision =
  /** Verify the request against `secret`. */
  | { outcome: 'verify'; secret: string }
  /** Refuse the request. `status` is the HTTP status to return. */
  | { outcome: 'refuse'; status: number; error: string; logMessage: string }
  /** Explicitly opted out of verification. Non-production only. */
  | { outcome: 'skip'; logMessage: string }

export interface WebhookPolicyInput {
  /** Provider name, used only for log/error text. */
  provider: string
  /** The configured secret, if any. */
  secret: string | undefined | null
  /** Defaults to `process.env`; injectable for tests. */
  env?: Record<string, string | undefined>
}

/**
 * Decide how to handle an inbound webhook, without performing any I/O.
 *
 * Kept pure so the policy itself is unit-testable and identical across routes.
 */
export function resolveWebhookPolicy({
  provider,
  secret,
  env = process.env,
}: WebhookPolicyInput): WebhookDecision {
  const isProduction = env.NODE_ENV === 'production'
  const hasSecret = typeof secret === 'string' && secret.trim() !== ''

  if (hasSecret) {
    return { outcome: 'verify', secret: secret as string }
  }

  // No secret configured.
  //
  // Outside production a developer may deliberately opt in to unverified
  // webhooks to exercise handler logic locally. This is an explicit action, not
  // a default, and startup validation refuses the flag in production.
  if (!isProduction && env.ALLOW_UNVERIFIED_WEBHOOKS === 'true') {
    return {
      outcome: 'skip',
      logMessage: `[webhook:${provider}] accepting UNVERIFIED request: ALLOW_UNVERIFIED_WEBHOOKS=true and no secret configured. Never use this in production.`,
    }
  }

  // Fail closed.
  return {
    outcome: 'refuse',
    status: 503,
    error: 'Webhook verification is not configured',
    logMessage: `[webhook:${provider}] refusing request: verification secret is not configured. Set the provider secret, or set ALLOW_UNVERIFIED_WEBHOOKS=true outside production to accept unverified requests deliberately.`,
  }
}

/**
 * Whether the operator has explicitly opted in to accepting unverified
 * webhooks. Only honoured outside production.
 *
 * For providers that authenticate by signature rather than a shared secret
 * (AWS SNS), there is nothing to "configure", so those routes consult this
 * directly instead of `resolveWebhookPolicy`.
 */
export function isUnverifiedWebhookOptIn(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env.NODE_ENV !== 'production' && env.ALLOW_UNVERIFIED_WEBHOOKS === 'true'
}

/**
 * Whether a hostname is an AWS SNS endpoint.
 *
 * A bare `endsWith('.amazonaws.com')` check is not sufficient: it also matches
 * attacker-controlled hosts such as an S3 bucket
 * (`my-bucket.s3.amazonaws.com`), which turns the SubscribeURL fetch and the
 * signing-certificate fetch into SSRF and signature-bypass vectors
 * respectively.
 */
export function isAwsSnsHostname(hostname: string): boolean {
  return /^sns\.[a-z0-9-]+\.amazonaws\.com$/.test(hostname.toLowerCase())
}

/**
 * Constant-time string comparison.
 *
 * Compares SHA-256 digests so that inputs of differing length take the same
 * path — `timingSafeEqual` throws on a length mismatch, and the naive
 * `a.length !== b.length` guard callers tend to write leaks length.
 *
 * Returns false for any non-equal input.
 */
export function safeCompare(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest()
  const digestB = createHash('sha256').update(b, 'utf8').digest()

  return timingSafeEqual(digestA, digestB)
}
