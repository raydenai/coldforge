import { describe, expect, it } from 'vitest'
import {
  campaignBlockReason,
  isEmailShaped,
  isZeroBounceConfigured,
  mapProviderStatus,
  normalizeEmail,
  parseImportedReport,
  parseTrustworthyDate,
  provenanceLabel,
  redactValidationError,
  validationLogFields,
} from '@/lib/outreach/validation'

describe('validation domain mapping', () => {
  it('maps every official ZeroBounce status', () => {
    expect(mapProviderStatus('valid')).toBe('valid')
    expect(mapProviderStatus('invalid')).toBe('invalid')
    expect(mapProviderStatus('catch-all')).toBe('risky')
    expect(mapProviderStatus('spamtrap')).toBe('invalid')
    expect(mapProviderStatus('abuse')).toBe('invalid')
    expect(mapProviderStatus('do_not_mail')).toBe('invalid')
    expect(mapProviderStatus('unknown')).toBe('unknown')
    expect(mapProviderStatus('something-new')).toBe('unknown')
  })

  it('detects provider configuration by presence without reading the value', () => {
    expect(isZeroBounceConfigured({ ZEROBOUNCE_API_KEY: 'k' })).toBe(true)
    expect(isZeroBounceConfigured({ ZEROBOUNCE_API_KEY: '   ' })).toBe(false)
    expect(isZeroBounceConfigured({})).toBe(false)
  })

  it('normalizes but never treats syntax as a mailbox verdict', () => {
    expect(normalizeEmail('  Person@Example.COM ')).toBe('person@example.com')
    expect(isEmailShaped('person@example.com')).toBe(true)
    expect(isEmailShaped('person@example')).toBe(false)
    expect(isEmailShaped('not-an-email')).toBe(false)
  })

  it('explains why each non-valid status cannot campaign', () => {
    expect(campaignBlockReason('valid')).toBeNull()
    expect(campaignBlockReason('invalid')).toMatch(/bounce/i)
    expect(campaignBlockReason('risky')).toMatch(/catch-all|risky/i)
    expect(campaignBlockReason('unknown')).toMatch(/no measured/i)
    expect(campaignBlockReason(null)).toMatch(/no validation/i)
  })

  it('labels provenance, including legacy values with no evidence row', () => {
    expect(provenanceLabel('verified_provider')).toMatch(/provider receipt/i)
    expect(provenanceLabel('verified_import')).toMatch(/imported/i)
    expect(provenanceLabel('unverified_legacy')).toMatch(/legacy/i)
    expect(provenanceLabel(undefined)).toMatch(/no recorded provenance/i)
  })

  it('trusts only plausible provider dates and drops the rest', () => {
    const now = new Date('2026-10-06T00:00:00.000Z')
    expect(parseTrustworthyDate('2026-10-05T12:00:00Z', now)).toBe('2026-10-05T12:00:00.000Z')
    expect(parseTrustworthyDate('not-a-date', now)).toBeNull()
    expect(parseTrustworthyDate('1990-01-01T00:00:00Z', now)).toBeNull()
    expect(parseTrustworthyDate('2026-10-06T01:00:00Z', now)).toBeNull()
    expect(parseTrustworthyDate(null, now)).toBeNull()
  })
})

describe('imported report parsing', () => {
  it('parses bounded CSV and skips a header row', () => {
    const result = parseImportedReport('email,status,reference\nperson@example.com,VALID,receipt-1\nother@example.com,catch-all')
    expect(result.errors).toEqual([])
    expect(result.rows).toEqual([
      { email: 'person@example.com', status: 'valid', reference: 'receipt-1' },
      { email: 'other@example.com', status: 'risky', reference: undefined },
    ])
  })

  it('parses a JSON array and normalizes addresses', () => {
    const result = parseImportedReport(JSON.stringify([{ email: 'Person@Example.com', status: 'unknown' }]))
    expect(result.errors).toEqual([])
    expect(result.rows[0]).toEqual({ email: 'person@example.com', status: 'unknown', reference: undefined })
  })

  it('rejects malformed rows instead of guessing', () => {
    const result = parseImportedReport('not-an-email,valid\nperson@example.com,maybe')
    expect(result.rows).toEqual([])
    expect(result.errors.join(' ')).toMatch(/invalid email/i)
    expect(result.errors.join(' ')).toMatch(/valid, invalid, risky, unknown/i)
  })

  it('rejects unparseable JSON', () => {
    expect(parseImportedReport('[{').errors[0]).toMatch(/could not be parsed/i)
  })
})

describe('error/log redaction', () => {
  it('never echoes an api key or recipient address', () => {
    const transport = Object.assign(new Error('connect failed for person@example.com key sk-live-secret'), { name: 'Error' })
    const message = redactValidationError(transport)
    expect(message).toBe('Validation could not be completed.')
    const timeout = Object.assign(new Error('aborted'), { name: 'ZeroBounceTimeoutError' })
    expect(redactValidationError(timeout)).toMatch(/deadline/i)
    expect(redactValidationError(timeout)).not.toMatch(/aborted/)
  })

  it('emits only correlation fields', () => {
    const fields = validationLogFields({
      operationId: 'op',
      organizationId: 'org',
      leadId: 'lead',
      source: 'zerobounce',
      state: 'held_unknown',
      validationStatus: 'unknown',
    })
    expect(Object.keys(fields).sort()).toEqual(['leadId', 'operationId', 'organizationId', 'source', 'state', 'validationStatus'])
    expect(JSON.stringify(fields)).not.toMatch(/@/)
  })
})
