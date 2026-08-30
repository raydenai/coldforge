import { describe, it, expect } from 'vitest'
import {
  resolveWebhookPolicy,
  isUnverifiedWebhookOptIn,
  isAwsSnsHostname,
  safeCompare,
} from '@/lib/webhooks/verification'

const prod = { NODE_ENV: 'production' }
const dev = { NODE_ENV: 'development' }

describe('webhook verification policy', () => {
  describe('resolveWebhookPolicy', () => {
    it('verifies when a secret is configured in production', () => {
      const decision = resolveWebhookPolicy({ provider: 'p', secret: 's3cret', env: prod })

      expect(decision.outcome).toBe('verify')
      expect(decision).toMatchObject({ secret: 's3cret' })
    })

    it('verifies when a secret is configured outside production', () => {
      const decision = resolveWebhookPolicy({ provider: 'p', secret: 's3cret', env: dev })

      expect(decision.outcome).toBe('verify')
    })

    // The core SEC-002 regression: absence of a secret must never widen access.
    it('refuses with 503 when the secret is missing in production', () => {
      const decision = resolveWebhookPolicy({ provider: 'p', secret: undefined, env: prod })

      expect(decision).toMatchObject({ outcome: 'refuse', status: 503 })
    })

    it('refuses when the secret is missing outside production', () => {
      const decision = resolveWebhookPolicy({ provider: 'p', secret: undefined, env: dev })

      expect(decision.outcome).toBe('refuse')
    })

    it('treats an empty or whitespace secret as missing', () => {
      expect(resolveWebhookPolicy({ provider: 'p', secret: '', env: prod }).outcome).toBe('refuse')
      expect(resolveWebhookPolicy({ provider: 'p', secret: '   ', env: prod }).outcome).toBe(
        'refuse'
      )
      expect(resolveWebhookPolicy({ provider: 'p', secret: null, env: prod }).outcome).toBe('refuse')
    })

    it('ignores ALLOW_UNVERIFIED_WEBHOOKS in production', () => {
      const decision = resolveWebhookPolicy({
        provider: 'p',
        secret: undefined,
        env: { ...prod, ALLOW_UNVERIFIED_WEBHOOKS: 'true' },
      })

      expect(decision.outcome).toBe('refuse')
    })

    it('skips only on an explicit opt-in outside production', () => {
      const decision = resolveWebhookPolicy({
        provider: 'p',
        secret: undefined,
        env: { ...dev, ALLOW_UNVERIFIED_WEBHOOKS: 'true' },
      })

      expect(decision.outcome).toBe('skip')
    })

    it('does not skip for a truthy-but-not-"true" opt-in value', () => {
      for (const value of ['1', 'yes', 'TRUE', 'on']) {
        const decision = resolveWebhookPolicy({
          provider: 'p',
          secret: undefined,
          env: { ...dev, ALLOW_UNVERIFIED_WEBHOOKS: value },
        })

        expect(decision.outcome, `value: ${value}`).toBe('refuse')
      }
    })

    it('never puts the secret in a refusal message', () => {
      const decision = resolveWebhookPolicy({ provider: 'p', secret: '  ', env: prod })

      expect(decision.outcome).toBe('refuse')
      if (decision.outcome === 'refuse') {
        expect(decision.error).not.toContain('  ')
        expect(decision.logMessage).not.toMatch(/secret is ['"]/)
      }
    })
  })

  describe('isUnverifiedWebhookOptIn', () => {
    it('is false in production even when set', () => {
      expect(isUnverifiedWebhookOptIn({ ...prod, ALLOW_UNVERIFIED_WEBHOOKS: 'true' })).toBe(false)
    })

    it('is false outside production when unset', () => {
      expect(isUnverifiedWebhookOptIn(dev)).toBe(false)
    })

    it('is true outside production when explicitly set', () => {
      expect(isUnverifiedWebhookOptIn({ ...dev, ALLOW_UNVERIFIED_WEBHOOKS: 'true' })).toBe(true)
    })
  })

  describe('isAwsSnsHostname', () => {
    it('accepts genuine regional SNS hosts', () => {
      expect(isAwsSnsHostname('sns.us-east-1.amazonaws.com')).toBe(true)
      expect(isAwsSnsHostname('sns.eu-west-2.amazonaws.com')).toBe(true)
      expect(isAwsSnsHostname('sns.ap-southeast-1.amazonaws.com')).toBe(true)
    })

    it('is case insensitive', () => {
      expect(isAwsSnsHostname('SNS.US-EAST-1.AMAZONAWS.COM')).toBe(true)
    })

    // The reason the suffix check was insufficient.
    it('rejects other amazonaws.com hosts', () => {
      expect(isAwsSnsHostname('my-bucket.s3.amazonaws.com')).toBe(false)
      expect(isAwsSnsHostname('s3.amazonaws.com')).toBe(false)
      expect(isAwsSnsHostname('evil.amazonaws.com')).toBe(false)
    })

    it('rejects lookalike domains', () => {
      expect(isAwsSnsHostname('sns.us-east-1.amazonaws.com.evil.test')).toBe(false)
      expect(isAwsSnsHostname('notamazonaws.com')).toBe(false)
      expect(isAwsSnsHostname('sns.us-east-1.amazonaws.co')).toBe(false)
      expect(isAwsSnsHostname('xsns.us-east-1.amazonaws.com')).toBe(false)
    })
  })

  describe('safeCompare', () => {
    it('is true for identical strings', () => {
      expect(safeCompare('token-abc', 'token-abc')).toBe(true)
    })

    it('is false for different strings of equal length', () => {
      expect(safeCompare('token-abc', 'token-abd')).toBe(false)
    })

    it('is false for different lengths without throwing', () => {
      expect(safeCompare('short', 'a-much-longer-value')).toBe(false)
    })

    it('handles empty strings', () => {
      expect(safeCompare('', '')).toBe(true)
      expect(safeCompare('', 'x')).toBe(false)
    })
  })
})
