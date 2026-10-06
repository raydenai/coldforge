/**
 * Signed unsubscribe tokens (SEC-004).
 *
 * The previous URL shape was:
 *   /unsubscribe?lead=<uuid>&campaign=<uuid>
 *
 * Two problems with that. It had no endpoint behind it at all, and the
 * identifiers were unauthenticated — anyone holding one email could enumerate or
 * forge opt-outs for other recipients, and a scraped id pair would let a third
 * party unsubscribe someone else.
 *
 * A token is `base64url(payload).base64url(hmac)`. The HMAC key is derived from
 * ENCRYPTION_SECRET with a domain separator so that a leak of one subsystem's
 * signatures says nothing about another's.
 *
 * Tokens deliberately DO NOT EXPIRE. CAN-SPAM requires an opt-out mechanism to
 * keep working for at least 30 days after send, and recipients routinely
 * unsubscribe from much older mail. An expired opt-out link is a compliance
 * failure, not a security feature.
 */

import { createHmac } from 'node:crypto'
import { safeCompare } from '@/lib/webhooks/verification'

/** Current token version. Bump when the payload shape changes. */
const TOKEN_VERSION = 1

/** Domain separator, so this key is unrelated to other ENCRYPTION_SECRET uses. */
const KEY_INFO = 'upmax:unsubscribe:v1'

export interface UnsubscribePayload {
  /** Token format version. */
  v: number
  /** Lead being unsubscribed. */
  leadId: string
  /** Campaign the message belonged to. Recorded for attribution. */
  campaignId: string
  /** Tenant that sent it. Scopes the suppression write. */
  workspaceId: string
}

export class UnsubscribeTokenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsubscribeTokenError'
  }
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

/**
 * Derive the signing key.
 *
 * Throws when ENCRYPTION_SECRET is absent rather than falling back to a default.
 * A predictable key here would let anyone mint valid opt-out tokens for any
 * recipient.
 */
function signingKey(): Buffer {
  const secret = process.env.ENCRYPTION_SECRET

  if (!secret || secret.trim() === '') {
    throw new UnsubscribeTokenError(
      'ENCRYPTION_SECRET is required to sign unsubscribe tokens. Refusing to use a default key.'
    )
  }

  return createHmac('sha256', secret).update(KEY_INFO).digest()
}

function sign(payloadPart: string): string {
  return b64url(createHmac('sha256', signingKey()).update(payloadPart).digest())
}

/** Mint a token for one recipient of one campaign. */
export function createUnsubscribeToken(input: {
  leadId: string
  campaignId: string
  workspaceId: string
}): string {
  const payload: UnsubscribePayload = {
    v: TOKEN_VERSION,
    leadId: input.leadId,
    campaignId: input.campaignId,
    workspaceId: input.workspaceId,
  }

  const payloadPart = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))

  return `${payloadPart}.${sign(payloadPart)}`
}

/**
 * Verify and decode a token.
 *
 * Throws on any tampering. Callers must treat a throw as "do not unsubscribe",
 * never as "unsubscribe anyway" — an attacker-supplied token must not be able to
 * suppress an arbitrary address either.
 */
export function verifyUnsubscribeToken(token: string): UnsubscribePayload {
  if (typeof token !== 'string' || token.length === 0) {
    throw new UnsubscribeTokenError('Missing token')
  }

  const parts = token.split('.')
  if (parts.length !== 2) {
    throw new UnsubscribeTokenError('Malformed token')
  }

  const [payloadPart, signaturePart] = parts as [string, string]

  if (!safeCompare(signaturePart, sign(payloadPart))) {
    throw new UnsubscribeTokenError('Invalid token signature')
  }

  let payload: UnsubscribePayload
  try {
    payload = JSON.parse(fromB64url(payloadPart).toString('utf8'))
  } catch {
    throw new UnsubscribeTokenError('Malformed token payload')
  }

  if (payload?.v !== TOKEN_VERSION) {
    throw new UnsubscribeTokenError(`Unsupported token version: ${payload?.v}`)
  }

  if (!payload.leadId || !payload.campaignId || !payload.workspaceId) {
    throw new UnsubscribeTokenError('Incomplete token payload')
  }

  return payload
}

/** Absolute one-click unsubscribe URL for a given recipient. */
export function buildUnsubscribeUrl(
  baseUrl: string,
  input: { leadId: string; campaignId: string; workspaceId: string }
): string {
  const token = createUnsubscribeToken(input)
  return `${baseUrl.replace(/\/+$/, '')}/unsubscribe?token=${encodeURIComponent(token)}`
}

/**
 * RFC 8058 headers.
 *
 * `List-Unsubscribe-Post` is meaningless on its own — it tells the mailbox
 * provider how to action a `List-Unsubscribe` target that must also be present.
 * The codebase previously emitted only the Post header, so the one-click
 * affordance advertised to Gmail and Yahoo pointed at nothing.
 *
 * `mailto:` is included as the RFC-recommended fallback when supplied.
 */
export function buildUnsubscribeHeaders(
  unsubscribeUrl: string,
  mailto?: string
): Record<string, string> {
  const targets = mailto ? `<${mailto}>, <${unsubscribeUrl}>` : `<${unsubscribeUrl}>`

  return {
    'List-Unsubscribe': targets,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  }
}
