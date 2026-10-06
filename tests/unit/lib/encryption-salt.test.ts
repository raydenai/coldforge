import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { encrypt, decrypt } from '@/lib/encryption'

/**
 * FND-012. The codebase derived its encryption key from a hardcoded fallback
 * salt (`instantscale-default-salt`) whenever ENCRYPTION_SALT was unset. A
 * public salt removes the per-install work factor, so an attacker holding
 * ciphertext and this repository only has to guess the secret.
 *
 * The fix cannot simply delete the constant: anything encrypted while it was in
 * force — stored SMTP and OAuth credentials — would become permanently
 * unreadable. So the legacy salt is decrypt-only.
 */

const SECRET = 'test-encryption-secret-32-characters!'
const LEGACY_SALT = 'instantscale-default-salt'

const original = {
  secret: process.env.ENCRYPTION_SECRET,
  salt: process.env.ENCRYPTION_SALT,
}

beforeEach(() => {
  process.env.ENCRYPTION_SECRET = SECRET
  process.env.ENCRYPTION_SALT = 'a-real-per-install-salt'
})

afterEach(() => {
  process.env.ENCRYPTION_SECRET = original.secret
  process.env.ENCRYPTION_SALT = original.salt
  vi.restoreAllMocks()
})

describe('encryption salt (FND-012)', () => {
  it('round-trips with a configured salt', () => {
    expect(decrypt(encrypt('sensitive-value'))).toBe('sensitive-value')
  })

  // The core fix: never write new ciphertext under a publicly known salt.
  it('REFUSES to encrypt when ENCRYPTION_SALT is absent', () => {
    delete process.env.ENCRYPTION_SALT

    expect(() => encrypt('secret')).toThrow(/ENCRYPTION_SALT environment variable is required/)
  })

  it('refuses to encrypt when ENCRYPTION_SALT is blank', () => {
    process.env.ENCRYPTION_SALT = '   '

    expect(() => encrypt('secret')).toThrow(/ENCRYPTION_SALT/)
  })

  it('still requires ENCRYPTION_SECRET', () => {
    delete process.env.ENCRYPTION_SECRET

    expect(() => encrypt('secret')).toThrow(/ENCRYPTION_SECRET/)
  })

  // Existing stored credentials must stay readable during migration.
  it('decrypts legacy ciphertext written under the hardcoded salt', () => {
    // Produce ciphertext exactly as the old code would have.
    process.env.ENCRYPTION_SALT = LEGACY_SALT
    const legacyCiphertext = encrypt('legacy-stored-credential')

    // Now run with a proper per-install salt, as a fixed deployment would.
    process.env.ENCRYPTION_SALT = 'a-real-per-install-salt'

    expect(decrypt(legacyCiphertext)).toBe('legacy-stored-credential')
  })

  it('warns loudly when legacy ciphertext is decrypted', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    process.env.ENCRYPTION_SALT = LEGACY_SALT
    const legacyCiphertext = encrypt('legacy-value')
    process.env.ENCRYPTION_SALT = 'a-real-per-install-salt'

    decrypt(legacyCiphertext)

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('LEGACY'))
  })

  it('does not warn for current-salt ciphertext', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    decrypt(encrypt('current-value'))

    expect(warn).not.toHaveBeenCalled()
  })

  // GCM authentication means a wrong key fails cleanly rather than returning
  // plausible garbage, so the multi-key attempt cannot silently mis-decrypt.
  it('throws when no candidate key matches', () => {
    const ciphertext = encrypt('value')
    process.env.ENCRYPTION_SECRET = 'an-entirely-different-secret-value!!'

    expect(() => decrypt(ciphertext)).toThrow()
  })

  it('rejects malformed ciphertext', () => {
    expect(() => decrypt('not-encrypted')).toThrow(/Invalid encrypted data format/)
  })
})
