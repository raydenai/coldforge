import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH = 32
const IV_LENGTH = 16
const AUTH_TAG_LENGTH = 16
// SALT_LENGTH = 32 (not currently used but documented for reference)

/**
 * The salt this codebase used before ENCRYPTION_SALT was required (FND-012).
 *
 * A hardcoded salt is predictable, so an attacker holding the ciphertext and
 * this public source needs only to guess ENCRYPTION_SECRET, with no per-install
 * work factor.
 *
 * It CANNOT simply be deleted: anything already encrypted while it was in force
 * would become permanently undecryptable, including stored SMTP and OAuth
 * credentials. So it is retained for DECRYPTION ONLY, is never used to encrypt
 * anything new, and warns on every use so operators can re-encrypt.
 */
const LEGACY_SALT = 'instantscale-default-salt'

function requireSecret(): string {
  const secret = process.env.ENCRYPTION_SECRET
  if (!secret || secret.trim() === '') {
    throw new Error('ENCRYPTION_SECRET environment variable is required')
  }
  return secret
}

/**
 * Key for encrypting NEW data.
 *
 * Throws when ENCRYPTION_SALT is absent. There is deliberately no fallback:
 * writing fresh ciphertext under a publicly known salt is the defect being
 * fixed, and silently doing so would keep producing weak data indefinitely.
 */
function getEncryptionKey(): Buffer {
  const salt = process.env.ENCRYPTION_SALT

  if (!salt || salt.trim() === '') {
    throw new Error(
      'ENCRYPTION_SALT environment variable is required to encrypt. ' +
        'Generate one with: openssl rand -hex 32'
    )
  }

  return scryptSync(requireSecret(), salt, KEY_LENGTH)
}

/**
 * Candidate keys for decryption, most-current first.
 *
 * Returns the legacy key as a fallback so historical ciphertext stays readable
 * during migration.
 */
function getDecryptionKeys(): Array<{ key: Buffer; legacy: boolean }> {
  const secret = requireSecret()
  const salt = process.env.ENCRYPTION_SALT
  const keys: Array<{ key: Buffer; legacy: boolean }> = []

  if (salt && salt.trim() !== '') {
    keys.push({ key: scryptSync(secret, salt, KEY_LENGTH), legacy: false })
  }

  keys.push({ key: scryptSync(secret, LEGACY_SALT, KEY_LENGTH), legacy: true })

  return keys
}

export function encrypt(text: string): string {
  const key = getEncryptionKey()
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)

  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')

  const authTag = cipher.getAuthTag()

  // Format: iv:authTag:encrypted
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`
}

export function decrypt(encryptedData: string): string {
  const [ivHex, authTagHex, encrypted] = encryptedData.split(':')

  if (!ivHex || !authTagHex || !encrypted) {
    throw new Error('Invalid encrypted data format')
  }

  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')

  // Try the current key, then the legacy one. GCM authentication means a wrong
  // key fails cleanly rather than returning garbage, so this cannot silently
  // mis-decrypt.
  let lastError: unknown

  for (const { key, legacy } of getDecryptionKeys()) {
    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv)
      decipher.setAuthTag(authTag)

      let decrypted = decipher.update(encrypted, 'hex', 'utf8')
      decrypted += decipher.final('utf8')

      if (legacy) {
        // Loud, because every hit is a credential still stored under a
        // publicly known salt. Re-encrypt it.
        console.warn(
          '[encryption] decrypted using the LEGACY hardcoded salt. ' +
            'This value must be re-encrypted with ENCRYPTION_SALT set. See FND-012.'
        )
      }

      return decrypted
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Failed to decrypt: no candidate key matched')
}

export function encryptObject<T extends object>(obj: T): string {
  return encrypt(JSON.stringify(obj))
}

export function decryptObject<T extends object>(encryptedData: string): T {
  const decrypted = decrypt(encryptedData)
  return JSON.parse(decrypted) as T
}

// Helper to check if a string is encrypted (has the expected format)
export function isEncrypted(value: string): boolean {
  const parts = value.split(':')
  return parts.length === 3 &&
         (parts[0]?.length ?? 0) === IV_LENGTH * 2 &&
         (parts[1]?.length ?? 0) === AUTH_TAG_LENGTH * 2
}
