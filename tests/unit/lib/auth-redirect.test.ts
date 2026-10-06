import { describe, it, expect } from 'vitest'
import {
  DEFAULT_APP_ENTRY,
  DEFAULT_POST_CONFIRMATION,
  sanitizeInternalPath,
} from '@/lib/auth/redirect'

describe('sanitizeInternalPath', () => {
  it('keeps valid same-origin paths and their query strings', () => {
    expect(sanitizeInternalPath('/settings')).toBe('/settings')
    expect(sanitizeInternalPath('/campaigns/123?tab=steps')).toBe(
      '/campaigns/123?tab=steps'
    )
    expect(sanitizeInternalPath('/onboarding')).toBe('/onboarding')
  })

  it('falls back to the app entry by default and to a caller fallback when given', () => {
    expect(sanitizeInternalPath(null)).toBe(DEFAULT_APP_ENTRY)
    expect(sanitizeInternalPath(null, DEFAULT_POST_CONFIRMATION)).toBe(
      DEFAULT_POST_CONFIRMATION
    )
    expect(sanitizeInternalPath(undefined)).toBe(DEFAULT_APP_ENTRY)
    expect(sanitizeInternalPath('')).toBe(DEFAULT_APP_ENTRY)
    expect(sanitizeInternalPath('   ')).toBe(DEFAULT_APP_ENTRY)
  })

  it('rejects absolute and protocol-relative external destinations', () => {
    expect(sanitizeInternalPath('https://evil.example/steal')).toBe(DEFAULT_APP_ENTRY)
    expect(sanitizeInternalPath('http://evil.example')).toBe(DEFAULT_APP_ENTRY)
    expect(sanitizeInternalPath('//evil.example')).toBe(DEFAULT_APP_ENTRY)
    expect(sanitizeInternalPath('javascript:alert(1)')).toBe(DEFAULT_APP_ENTRY)
    expect(sanitizeInternalPath('///evil.example')).toBe(DEFAULT_APP_ENTRY)
  })

  it('rejects encoded and backslash external bypasses', () => {
    expect(sanitizeInternalPath('/%2F%2Fevil.example')).toBe(DEFAULT_APP_ENTRY)
    expect(sanitizeInternalPath('/\\evil.example')).toBe(DEFAULT_APP_ENTRY)
    expect(sanitizeInternalPath('/%5Cevil.example')).toBe(DEFAULT_APP_ENTRY)
    expect(sanitizeInternalPath('/settings\nSet-Cookie: x=y')).toBe(DEFAULT_APP_ENTRY)
    expect(sanitizeInternalPath('/settings\u0000')).toBe(DEFAULT_APP_ENTRY)
  })

  it('rejects auth-loop paths so a fresh session is not discarded', () => {
    expect(sanitizeInternalPath('/login')).toBe(DEFAULT_APP_ENTRY)
    expect(sanitizeInternalPath('/login?verify=email')).toBe(DEFAULT_APP_ENTRY)
    expect(sanitizeInternalPath('/register')).toBe(DEFAULT_APP_ENTRY)
    expect(sanitizeInternalPath('/forgot-password')).toBe(DEFAULT_APP_ENTRY)
    expect(sanitizeInternalPath('/auth/callback?code=abc')).toBe(DEFAULT_APP_ENTRY)
    expect(sanitizeInternalPath('/api/auth/anything')).toBe(DEFAULT_APP_ENTRY)
  })
})
