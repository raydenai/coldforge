import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  createUnsubscribeToken,
  verifyUnsubscribeToken,
  buildUnsubscribeUrl,
  buildUnsubscribeHeaders,
  UnsubscribeTokenError,
} from '@/lib/compliance/unsubscribe-token'

const SUBJECT = {
  leadId: '11111111-1111-1111-1111-111111111111',
  campaignId: '22222222-2222-2222-2222-222222222222',
  workspaceId: '33333333-3333-3333-3333-333333333333',
}

const ORIGINAL_SECRET = process.env.ENCRYPTION_SECRET

beforeEach(() => {
  process.env.ENCRYPTION_SECRET = 'test-secret-value-for-signing-only'
})

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.ENCRYPTION_SECRET
  else process.env.ENCRYPTION_SECRET = ORIGINAL_SECRET
})

describe('unsubscribe tokens', () => {
  it('round-trips a payload', () => {
    const payload = verifyUnsubscribeToken(createUnsubscribeToken(SUBJECT))

    expect(payload.leadId).toBe(SUBJECT.leadId)
    expect(payload.campaignId).toBe(SUBJECT.campaignId)
    expect(payload.workspaceId).toBe(SUBJECT.workspaceId)
    expect(payload.v).toBe(1)
  })

  it('is deterministic for the same subject', () => {
    expect(createUnsubscribeToken(SUBJECT)).toBe(createUnsubscribeToken(SUBJECT))
  })

  it('produces different tokens for different leads', () => {
    const other = createUnsubscribeToken({ ...SUBJECT, leadId: 'different-lead' })
    expect(other).not.toBe(createUnsubscribeToken(SUBJECT))
  })

  // The whole point: the old ?lead=&campaign= shape let anyone forge an opt-out
  // for any recipient.
  it('rejects a tampered payload', () => {
    const token = createUnsubscribeToken(SUBJECT)
    const [, signature] = token.split('.')

    const forgedPayload = Buffer.from(
      JSON.stringify({ v: 1, ...SUBJECT, leadId: 'victim-lead-id' }),
      'utf8'
    )
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    expect(() => verifyUnsubscribeToken(`${forgedPayload}.${signature}`)).toThrow(
      UnsubscribeTokenError
    )
  })

  it('rejects a tampered signature', () => {
    const [payload] = createUnsubscribeToken(SUBJECT).split('.')
    expect(() => verifyUnsubscribeToken(`${payload}.not-a-signature`)).toThrow(
      UnsubscribeTokenError
    )
  })

  it('rejects tokens signed with a different secret', () => {
    const token = createUnsubscribeToken(SUBJECT)
    process.env.ENCRYPTION_SECRET = 'a-completely-different-secret'

    expect(() => verifyUnsubscribeToken(token)).toThrow(UnsubscribeTokenError)
  })

  it.each([
    ['empty', ''],
    ['no separator', 'abcdef'],
    ['too many parts', 'a.b.c'],
    ['garbage payload', 'not-base64!!.sig'],
  ])('rejects a malformed token (%s)', (_label, token) => {
    expect(() => verifyUnsubscribeToken(token)).toThrow(UnsubscribeTokenError)
  })

  // A predictable key would let anyone mint opt-outs for any address.
  it('refuses to sign when ENCRYPTION_SECRET is absent', () => {
    delete process.env.ENCRYPTION_SECRET
    expect(() => createUnsubscribeToken(SUBJECT)).toThrow(/ENCRYPTION_SECRET is required/)
  })

  it('refuses to sign when ENCRYPTION_SECRET is blank', () => {
    process.env.ENCRYPTION_SECRET = '   '
    expect(() => createUnsubscribeToken(SUBJECT)).toThrow(/ENCRYPTION_SECRET is required/)
  })

  it('produces a url-safe token', () => {
    expect(createUnsubscribeToken(SUBJECT)).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  })
})

describe('buildUnsubscribeUrl', () => {
  it('builds an absolute url carrying the token', () => {
    const url = buildUnsubscribeUrl('https://mail.example.com', SUBJECT)

    expect(url.startsWith('https://mail.example.com/unsubscribe?token=')).toBe(true)
    const token = decodeURIComponent(new URL(url).searchParams.get('token') as string)
    expect(verifyUnsubscribeToken(token).leadId).toBe(SUBJECT.leadId)
  })

  it('does not double the slash on a trailing-slash base', () => {
    expect(buildUnsubscribeUrl('https://mail.example.com/', SUBJECT)).toContain(
      'https://mail.example.com/unsubscribe?'
    )
  })

  // Raw identifiers in the query string were the original defect.
  it('does not leak raw identifiers into the url', () => {
    const url = buildUnsubscribeUrl('https://mail.example.com', SUBJECT)

    expect(url).not.toContain(SUBJECT.leadId)
    expect(url).not.toContain(SUBJECT.campaignId)
  })
})

describe('buildUnsubscribeHeaders (RFC 8058)', () => {
  const URL_ = 'https://mail.example.com/unsubscribe?token=abc'

  it('emits List-Unsubscribe alongside List-Unsubscribe-Post', () => {
    const headers = buildUnsubscribeHeaders(URL_)

    expect(headers['List-Unsubscribe']).toBe(`<${URL_}>`)
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
  })

  it('includes a mailto fallback first when supplied', () => {
    const headers = buildUnsubscribeHeaders(URL_, 'unsub@example.com')

    expect(headers['List-Unsubscribe']).toBe(`<unsub@example.com>, <${URL_}>`)
  })

  // Regression: the codebase previously shipped the Post header alone, which
  // advertises one-click to Gmail/Yahoo with no target to call.
  it('never emits the Post header without a target', () => {
    const headers = buildUnsubscribeHeaders(URL_)

    expect(Object.keys(headers)).toContain('List-Unsubscribe')
    expect(headers['List-Unsubscribe']).toBeTruthy()
  })
})
