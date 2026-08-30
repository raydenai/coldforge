import { describe, it, expect, vi, afterEach } from 'vitest'
import { checkEnv, validateEnv } from '@/lib/env'

/** Minimum bag that satisfies the always-required keys. */
const baseEnv = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  NEXT_PUBLIC_APP_URL: 'http://localhost:4000',
  NODE_ENV: 'development',
}

const productionSecrets = {
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  ENCRYPTION_SECRET: 'encryption-secret',
  ENCRYPTION_SALT: 'encryption-salt',
  CRON_SECRET: 'cron-secret',
}

const keysOf = (problems: { key: string }[]) => problems.map((p) => p.key)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('env', () => {
  describe('checkEnv', () => {
    it('accepts a minimal development environment', () => {
      const result = checkEnv(baseEnv)

      expect(result.problems).toEqual([])
      expect(result.ok).toBe(true)
    })

    it('reports each missing always-required key', () => {
      const result = checkEnv({ NODE_ENV: 'development' })

      expect(result.ok).toBe(false)
      expect(keysOf(result.problems)).toEqual(
        expect.arrayContaining([
          'NEXT_PUBLIC_SUPABASE_URL',
          'NEXT_PUBLIC_SUPABASE_ANON_KEY',
          'NEXT_PUBLIC_APP_URL',
        ])
      )
    })

    it('rejects a malformed URL', () => {
      const result = checkEnv({ ...baseEnv, NEXT_PUBLIC_APP_URL: 'not-a-url' })

      expect(result.ok).toBe(false)
      expect(keysOf(result.problems)).toContain('NEXT_PUBLIC_APP_URL')
    })

    it('does not require production secrets in development', () => {
      const result = checkEnv(baseEnv)

      expect(keysOf(result.problems)).not.toContain('ENCRYPTION_SECRET')
    })

    it('requires production secrets when NODE_ENV=production', () => {
      const result = checkEnv({ ...baseEnv, NODE_ENV: 'production' })

      expect(result.ok).toBe(false)
      expect(keysOf(result.problems)).toEqual(
        expect.arrayContaining([
          'SUPABASE_SERVICE_ROLE_KEY',
          'ENCRYPTION_SECRET',
          'ENCRYPTION_SALT',
          'CRON_SECRET',
        ])
      )
    })

    it('treats a blank production secret as missing', () => {
      const result = checkEnv({
        ...baseEnv,
        ...productionSecrets,
        NODE_ENV: 'production',
        ENCRYPTION_SECRET: '   ',
      })

      expect(result.ok).toBe(false)
      expect(keysOf(result.problems)).toContain('ENCRYPTION_SECRET')
    })

    it('accepts a fully configured production environment', () => {
      const result = checkEnv({ ...baseEnv, ...productionSecrets, NODE_ENV: 'production' })

      expect(result.problems).toEqual([])
      expect(result.ok).toBe(true)
    })

    it('refuses SMTP_ALLOW_SELF_SIGNED in production', () => {
      const result = checkEnv({
        ...baseEnv,
        ...productionSecrets,
        NODE_ENV: 'production',
        SMTP_ALLOW_SELF_SIGNED: 'true',
      })

      expect(result.ok).toBe(false)
      expect(keysOf(result.problems)).toContain('SMTP_ALLOW_SELF_SIGNED')
    })

    it('permits SMTP_ALLOW_SELF_SIGNED outside production', () => {
      const result = checkEnv({ ...baseEnv, SMTP_ALLOW_SELF_SIGNED: 'true' })

      expect(result.ok).toBe(true)
    })

    it('refuses ALLOW_UNVERIFIED_WEBHOOKS in production', () => {
      const result = checkEnv({
        ...baseEnv,
        ...productionSecrets,
        NODE_ENV: 'production',
        ALLOW_UNVERIFIED_WEBHOOKS: 'true',
      })

      expect(result.ok).toBe(false)
      expect(keysOf(result.problems)).toContain('ALLOW_UNVERIFIED_WEBHOOKS')
    })

    it('permits ALLOW_UNVERIFIED_WEBHOOKS outside production', () => {
      const result = checkEnv({ ...baseEnv, ALLOW_UNVERIFIED_WEBHOOKS: 'true' })

      expect(result.ok).toBe(true)
    })

    it('rejects a non-numeric REDIS_PORT', () => {
      const result = checkEnv({ ...baseEnv, REDIS_PORT: 'abc' })

      expect(result.ok).toBe(false)
      expect(keysOf(result.problems)).toContain('REDIS_PORT')
    })

    it('rejects an unknown LOG_LEVEL', () => {
      const result = checkEnv({ ...baseEnv, LOG_LEVEL: 'chatty' })

      expect(result.ok).toBe(false)
      expect(keysOf(result.problems)).toContain('LOG_LEVEL')
    })
  })

  describe('validateEnv', () => {
    it('throws in production when configuration is invalid', () => {
      expect(() => validateEnv({ ...baseEnv, NODE_ENV: 'production' })).toThrow(
        /Environment validation failed/
      )
    })

    it('warns but does not throw outside production', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      expect(() => validateEnv({ NODE_ENV: 'development' })).not.toThrow()
      expect(warn).toHaveBeenCalledOnce()
    })

    it('is silent when configuration is valid', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      expect(() => validateEnv(baseEnv)).not.toThrow()
      expect(warn).not.toHaveBeenCalled()
    })

    it('never includes secret values in the failure message', () => {
      const secret = 'super-secret-value-do-not-log'

      try {
        validateEnv({
          ...baseEnv,
          NODE_ENV: 'production',
          SUPABASE_SERVICE_ROLE_KEY: secret,
          // ENCRYPTION_SECRET intentionally absent to force a failure
        })
        throw new Error('expected validateEnv to throw')
      } catch (error) {
        const message = (error as Error).message
        expect(message).toContain('ENCRYPTION_SECRET')
        expect(message).not.toContain(secret)
      }
    })
  })
})
