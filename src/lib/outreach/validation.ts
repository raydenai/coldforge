/**
 * Lead email validation domain: status mapping, provenance labels, config
 * probing, bounded import parsing, and log/error redaction.
 *
 * This module never reads or returns a provider secret. `ZEROBOUNCE_API_KEY`
 * is only checked for presence here; the value is read exclusively by the
 * server-side adapter immediately before the provider request.
 */

export type ValidationStatus = 'valid' | 'invalid' | 'risky' | 'unknown'
export type VerificationLevel =
  | 'verified_provider'
  | 'verified_import'
  | 'unverified_unknown'
  | 'unverified_legacy'
export type ValidationSource = 'zerobounce' | 'imported_report'

export type ProviderStatus =
  | 'valid'
  | 'invalid'
  | 'catch-all'
  | 'unknown'
  | 'spamtrap'
  | 'abuse'
  | 'do_not_mail'

export const ZEROBOUNCE = {
  name: 'zerobounce',
  endpoint: 'https://api.zerobounce.net/v2/validate',
  timeoutSeconds: 10,
  maxResponseChars: 32_768,
} as const

export const VALIDATION_STATUSES: readonly ValidationStatus[] = ['valid', 'invalid', 'risky', 'unknown']

/** Imported reports are bounded; anything larger is rejected at the boundary. */
export const IMPORT_MAX_ROWS = 500

/** Hard cap on any validation request body read into memory before parsing. */
export const MAX_JSON_BYTES = 1_000_000

/** Earliest date we will treat as a real provider/report timestamp. */
const MIN_TRUSTWORTHY_MS = Date.UTC(2000, 0, 1)
/** Tolerated clock skew for a provider timestamp that is slightly ahead. */
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000

/**
 * Parse a provider-supplied timestamp into a normalized ISO string, or return
 * null when it is missing, not a real date, implausibly old, or too far in the
 * future. Callers must never treat an unparseable value as a trusted date.
 */
export function parseTrustworthyDate(value: string | null | undefined, now: Date = new Date()): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 100) return null
  const ms = Date.parse(trimmed)
  if (Number.isNaN(ms) || ms < MIN_TRUSTWORTHY_MS || ms > now.getTime() + MAX_FUTURE_SKEW_MS) return null
  return new Date(ms).toISOString()
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** Conservative shape check. This is syntax only, never a mailbox claim. */
export function isEmailShaped(email: string): boolean {
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(normalizeEmail(email))
}

/** Presence-only check; the key value is never read or logged here. */
export function isZeroBounceConfigured(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.ZEROBOUNCE_API_KEY
  return typeof value === 'string' && value.trim().length > 0
}

/** Official ZeroBounce statuses -> the four local validation statuses. */
export function mapProviderStatus(status: string): ValidationStatus {
  switch (status) {
    case 'valid':
      return 'valid'
    case 'invalid':
      return 'invalid'
    case 'catch-all':
      return 'risky'
    case 'spamtrap':
    case 'abuse':
    case 'do_not_mail':
      return 'invalid'
    default:
      return 'unknown'
  }
}

/**
 * Why a lead with this status is not eligible for campaign enrollment
 * (campaign 022 and dispatch 024 both require `valid`).
 */
export function campaignBlockReason(status: string | null | undefined): string | null {
  switch (status) {
    case 'valid':
      return null
    case 'invalid':
      return 'Invalid addresses cannot be enrolled: sending would bounce and damage sender reputation.'
    case 'risky':
      return 'Catch-all or risky addresses cannot be enrolled: delivery is uncertain, so they need review first.'
    case 'unknown':
      return 'Unknown means no measured mailbox verdict is on file, so this address cannot be enrolled yet.'
    default:
      return 'No validation has been recorded for this address, so it cannot be enrolled yet.'
  }
}

export function provenanceLabel(level: VerificationLevel | null | undefined): string {
  switch (level) {
    case 'verified_provider':
      return 'Verified by provider receipt'
    case 'verified_import':
      return 'Imported report (owner-attested)'
    case 'unverified_unknown':
      return 'Unverified result'
    case 'unverified_legacy':
      return 'Legacy value, no provenance'
    default:
      return 'No recorded provenance'
  }
}

export interface ImportedReportRow {
  email: string
  status: ValidationStatus
  reference?: string
}

export interface ImportParseResult {
  rows: ImportedReportRow[]
  errors: string[]
}

const PROVIDER_STATUS_TOKENS = ['valid', 'invalid', 'catch-all', 'unknown', 'spamtrap', 'abuse', 'do_not_mail'] as const

function parseImportStatus(value: string): ValidationStatus | null {
  const status = value.trim().toLowerCase().replace(/\s+/g, '-')
  if ((VALIDATION_STATUSES as readonly string[]).includes(status)) return status as ValidationStatus
  // Accept provider-native exports too, mapping them to the local four.
  if ((PROVIDER_STATUS_TOKENS as readonly string[]).includes(status)) return mapProviderStatus(status)
  return null
}

/**
 * Parse a bounded CSV or JSON import report. Accepts either a JSON array of
 * `{email,status,reference?}` objects or CSV lines of `email,status[,reference]`.
 * Never treats a line as verified on its own; that label is applied only after
 * the owner attests and the RPC stores it.
 */
export function parseImportedReport(text: string): ImportParseResult {
  const errors: string[] = []
  const trimmed = text.trim()
  if (!trimmed) return { rows: [], errors: ['The report is empty.'] }

  const rows: ImportedReportRow[] = []
  const seen = new Set<string>()

  const push = (email: unknown, status: unknown, reference: unknown, index: number) => {
    if (rows.length >= IMPORT_MAX_ROWS) {
      errors.push(`Too many rows: the limit is ${IMPORT_MAX_ROWS}.`)
      return
    }
    if (typeof email !== 'string' || !isEmailShaped(email)) {
      errors.push(`Row ${index + 1}: invalid email address.`)
      return
    }
    if (typeof status !== 'string') {
      errors.push(`Row ${index + 1}: missing status.`)
      return
    }
    const parsedStatus = parseImportStatus(status)
    if (!parsedStatus) {
      errors.push(`Row ${index + 1}: status must be one of valid, invalid, risky, unknown.`)
      return
    }
    const normalized = normalizeEmail(email)
    if (seen.has(normalized)) {
      errors.push(`Row ${index + 1}: duplicate address ignored.`)
      return
    }
    seen.add(normalized)
    rows.push({
      email: normalized,
      status: parsedStatus,
      reference: typeof reference === 'string' && reference.trim() ? reference.trim().slice(0, 300) : undefined,
    })
  }

  if (trimmed.startsWith('[')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return { rows: [], errors: ['The JSON report could not be parsed.'] }
    }
    if (!Array.isArray(parsed)) return { rows: [], errors: ['The JSON report must be an array.'] }
    parsed.forEach((entry, index) => {
      if (typeof entry !== 'object' || entry === null) {
        errors.push(`Row ${index + 1}: expected an object.`)
        return
      }
      const record = entry as Record<string, unknown>
      push(record.email, record.status, record.reference, index)
    })
    return { rows, errors }
  }

  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0)
  lines.forEach((line, index) => {
    const cells = line.split(',').map((cell) => cell.trim())
    if (index === 0 && /email/i.test(cells[0] ?? '') && /status/i.test(cells[1] ?? '')) return
    push(cells[0], cells[1], cells[2], index)
  })
  return { rows, errors }
}

/**
 * Redact an arbitrary provider/transport failure to a safe, stable message.
 * Recipient addresses and secrets are never included.
 */
export function redactValidationError(error: unknown): string {
  if (error instanceof Error) {
    switch (error.name) {
      case 'ZeroBounceTimeoutError':
        return 'The validation provider did not respond before the deadline.'
      case 'ZeroBounceNotConfiguredError':
        return 'The validation provider is not configured.'
      case 'ZeroBounceAddressMismatchError':
        return 'The provider response did not match the requested address.'
      case 'ZeroBounceResponseError':
        return 'The validation provider returned an error response.'
      case 'ZeroBounceInvalidResponseError':
        return 'The validation provider returned an unreadable response.'
      default:
        break
    }
  }
  return 'Validation could not be completed.'
}

/** Structured log fields: correlation and status only, never PII or secrets. */
export function validationLogFields(input: {
  operationId: string
  organizationId: string
  leadId: string
  source: ValidationSource
  state?: string
  validationStatus?: ValidationStatus | null
}): Record<string, string | null | undefined> {
  return {
    operationId: input.operationId,
    organizationId: input.organizationId,
    leadId: input.leadId,
    source: input.source,
    state: input.state,
    validationStatus: input.validationStatus ?? null,
  }
}
