/**
 * Winnr webhook signature verification.
 *
 * Official delivery contract (top-level `webhooks` section of the public Winnr
 * OpenAPI document, `https://app.winnr.app/openapi.yaml`, downloaded
 * 2026-10-05, SHA256
 * 675267d3d22d098b73ee5379570bd0e6badaac326e7a3e4229822e9f13c1e994):
 *
 *   - `X-Winnr-Timestamp` — unix seconds when the delivery was signed
 *   - `X-Winnr-Signature` — `v1=<hex>` where `<hex>` is
 *     HMAC-SHA256("{timestamp}.{raw_body}") keyed with the endpoint's `whsec_`
 *     secret. During the 24h rotation grace window there are TWO
 *     comma-separated `v1=` values (old and new secret) — accept the delivery
 *     if ANY value matches.
 *
 * Receiver rules implemented here:
 *   - absent/blank secret fails closed;
 *   - malformed, non-numeric or whitespace-padded timestamps fail closed;
 *   - deliveries more than 300 seconds from `now` are rejected (replay bound);
 *   - comparison is constant time and never throws on hostile input.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/** Replay window, in seconds, for the signed timestamp. */
export const WINNR_WEBHOOK_MAX_SKEW_SECONDS = 300

export interface WinnrSignatureHeaders {
  timestamp: string | null
  signature: string | null
}

/**
 * Constant-time string equality. Both inputs are hashed first so differing
 * lengths take the same code path (`timingSafeEqual` throws on length
 * mismatch, and a length guard would leak length).
 */
function constantTimeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest()
  const digestB = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(digestA, digestB)
}

/**
 * Verify an inbound Winnr webhook.
 *
 * @param rawBody raw request bytes exactly as received (never a re-serialized
 *   object — the signature covers the bytes on the wire).
 * @param headers `X-Winnr-Timestamp` / `X-Winnr-Signature` values, or null.
 * @param secret the endpoint's `whsec_` signing secret.
 * @param now current time in epoch milliseconds; injectable for tests.
 */
export function verifyWinnrSignature(
  rawBody: string | Buffer,
  headers: WinnrSignatureHeaders,
  secret: string,
  now: number = Date.now()
): boolean {
  try {
    if (typeof secret !== 'string' || secret.trim() === '') return false
    if (!Number.isFinite(now)) return false
    if (!headers) return false

    const { timestamp, signature } = headers
    // Unix seconds only; rejects padded, signed, decimal and newline values.
    if (typeof timestamp !== 'string' || !/^\d{1,20}$/.test(timestamp)) return false
    if (typeof signature !== 'string' || signature === '') return false

    const timestampSeconds = Number(timestamp)
    if (!Number.isFinite(timestampSeconds)) return false
    if (Math.abs(now / 1000 - timestampSeconds) > WINNR_WEBHOOK_MAX_SKEW_SECONDS) return false

    const bodyBytes = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody
    const expected = createHmac('sha256', secret)
      .update(`${timestamp}.`)
      .update(bodyBytes)
      .digest('hex')

    // Rotation grace: accept if ANY comma-separated v1 value matches.
    let matched = false
    for (const entry of signature.split(',')) {
      const trimmed = entry.trim()
      if (!trimmed.toLowerCase().startsWith('v1=')) continue
      const candidate = trimmed.slice('v1='.length).trim().toLowerCase()
      if (!/^[0-9a-f]+$/.test(candidate)) continue
      if (constantTimeEqual(expected, candidate)) matched = true
    }
    return matched
  } catch {
    return false
  }
}
