/**
 * ZeroBounce email validation adapter.
 *
 * Official contract (verified 2026-10-05):
 *   https://zerobounce.net/docs/email-validation-api-quickstart/v2-validate-emails
 *   POST https://api.zerobounce.net/v2/validate
 *   application/x-www-form-urlencoded: api_key, email, timeout (3..60)
 *   response: address, status, sub_status, processed_at
 *
 * Hard rules enforced here:
 *   * fixed origin, no caller-supplied URL;
 *   * manual redirects are refused rather than followed;
 *   * no automatic retry (exactly one request per call);
 *   * a hard deadline (default 10s) and a bounded response body;
 *   * the returned `address` must exactly equal the normalized request address;
 *   * the API key and recipient address never appear in thrown messages.
 */
import { z } from 'zod'
import {
  ZEROBOUNCE,
  isEmailShaped,
  normalizeEmail,
  parseTrustworthyDate,
  type ProviderStatus,
} from './validation'

export class ZeroBounceNotConfiguredError extends Error {
  constructor() {
    super('zerobounce_not_configured')
    this.name = 'ZeroBounceNotConfiguredError'
  }
}
export class ZeroBounceTimeoutError extends Error {
  constructor() {
    super('zerobounce_timeout')
    this.name = 'ZeroBounceTimeoutError'
  }
}
export class ZeroBounceResponseError extends Error {
  constructor(readonly reason: string) {
    super('zerobounce_response_error')
    this.name = 'ZeroBounceResponseError'
  }
}
export class ZeroBounceInvalidResponseError extends Error {
  constructor() {
    super('zerobounce_invalid_response')
    this.name = 'ZeroBounceInvalidResponseError'
  }
}
export class ZeroBounceAddressMismatchError extends Error {
  constructor() {
    super('zerobounce_address_mismatch')
    this.name = 'ZeroBounceAddressMismatchError'
  }
}

const receiptSchema = z.object({
  address: z.string().min(1).max(254),
  status: z.enum(['valid', 'invalid', 'catch-all', 'unknown', 'spamtrap', 'abuse', 'do_not_mail']),
  sub_status: z.string().max(100).nullish(),
  processed_at: z.string().max(100).nullish(),
})

export interface ZeroBounceReceipt {
  provider: 'zerobounce'
  address: string
  status: ProviderStatus
  substatus: string | null
  /** Normalized provider `processed_at`, or null when it is not trustworthy. */
  processedAt: string | null
  /** Server receipt time; the only timestamp trusted for `checkedAt`. */
  receivedAt: string
}

export interface ZeroBounceAdapterOptions {
  apiKey: string
  fetchImpl?: typeof fetch
  /** 3..60 seconds; defaults to the bounded 10s deadline. */
  timeoutMs?: number
  maxResponseChars?: number
  now?: () => Date
}

export async function validateWithZeroBounce(
  email: string,
  options: ZeroBounceAdapterOptions
): Promise<ZeroBounceReceipt> {
  const normalized = normalizeEmail(email)
  if (!options.apiKey || options.apiKey.trim().length === 0) throw new ZeroBounceNotConfiguredError()
  if (!isEmailShaped(normalized)) throw new ZeroBounceAddressMismatchError()

  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? ZEROBOUNCE.timeoutSeconds * 1000, 3_000), 60_000)
  const timeoutSeconds = Math.min(Math.max(Math.round(timeoutMs / 1000), 3), 60)
  const maxChars = options.maxResponseChars ?? ZEROBOUNCE.maxResponseChars
  const fetchImpl = options.fetchImpl ?? fetch

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Response
  try {
    response = await fetchImpl(ZEROBOUNCE.endpoint, {
      method: 'POST',
      redirect: 'manual',
      cache: 'no-store',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ api_key: options.apiKey, email: normalized, timeout: String(timeoutSeconds) }).toString(),
      signal: controller.signal,
    })
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw new ZeroBounceTimeoutError()
    }
    throw new ZeroBounceResponseError('transport_error')
  } finally {
    clearTimeout(timer)
  }

  // `redirect: 'manual'` surfaces 3xx as an opaque response; never follow it.
  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    throw new ZeroBounceResponseError('redirect_refused')
  }
  if (!response.ok) throw new ZeroBounceResponseError(`provider_http_${response.status}`)

  const text = await response.text()
  if (text.length > maxChars) throw new ZeroBounceInvalidResponseError()

  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new ZeroBounceInvalidResponseError()
  }
  const parsed = receiptSchema.safeParse(json)
  if (!parsed.success) throw new ZeroBounceInvalidResponseError()

  // Exact normalized match: a receipt for a different address proves nothing.
  if (normalizeEmail(parsed.data.address) !== normalized) throw new ZeroBounceAddressMismatchError()

  // The server receive time is the only timestamp trusted for freshness; the
  // provider `processed_at` is kept as a reference only when it parses to a
  // real, plausible date.
  const receivedAt = (options.now ? options.now() : new Date()).toISOString()
  return {
    provider: 'zerobounce',
    address: normalized,
    status: parsed.data.status,
    substatus: parsed.data.sub_status ?? null,
    processedAt: parseTrustworthyDate(parsed.data.processed_at, new Date(receivedAt)),
    receivedAt,
  }
}
