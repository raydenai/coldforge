/**
 * Quiet hours, timezone and frequency policy (CAM-002, CAM-007, SEC-010).
 *
 * `src/lib/sending/scheduler.ts` had `getNextSendWindow(_timezone, ...)` which
 * accepted a timezone and ignored it, computing hours from `now.getHours()` —
 * the *server's* wall clock. A recipient in Asia/Tokyo would be mailed at 03:00
 * local time from a US-hosted worker. Quiet hours are a policy control in
 * several jurisdictions, so that is a compliance defect and not only a
 * deliverability one.
 *
 * Everything here is pure and timezone-correct via `Intl`, with no new
 * dependency. Timestamps are UTC instants; "local" always means local to the
 * recipient.
 */

/** Inclusive start hour, exclusive end hour, in recipient-local time. */
export interface SendWindow {
  /** 0-23. */
  startHour: number
  /** 1-24. Exclusive. */
  endHour: number
  /**
   * Days the window is open, 0 = Sunday .. 6 = Saturday.
   * Defaults to Monday-Friday: cold outreach at the weekend converts poorly and
   * reads as spam.
   */
  days?: readonly number[]
}

export const DEFAULT_SEND_WINDOW: SendWindow = {
  startHour: 9,
  endHour: 17,
  days: [1, 2, 3, 4, 5],
}

/** Wall-clock fields for an instant, as observed in a specific timezone. */
export interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  /** 0 = Sunday .. 6 = Saturday. */
  weekday: number
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

/**
 * Validate a timezone identifier.
 *
 * An unknown zone must not silently degrade to UTC — that reintroduces exactly
 * the bug this module exists to fix, just less visibly.
 */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

/** Break an instant into recipient-local wall-clock fields. */
export function getZonedParts(instant: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    weekday: 'short',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

  const parts: Record<string, string> = {}
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = part.value
  }

  // Intl can emit hour "24" for midnight under hour12:false in some engines.
  const rawHour = Number(parts.hour)

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_INDEX[parts.weekday ?? ''] ?? 0,
  }
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p = getZonedParts(instant, timeZone)
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  // Discard sub-second drift so the arithmetic stays exact.
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000
}

/**
 * Convert a recipient-local wall-clock time to a UTC instant.
 *
 * Applied twice, because the offset itself depends on the instant — a single
 * pass is wrong across a DST boundary.
 */
export function zonedWallClockToUtc(
  timeZone: string,
  local: { year: number; month: number; day: number; hour: number; minute?: number }
): Date {
  const naive = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute ?? 0, 0)

  const firstGuess = new Date(naive - zoneOffsetMs(new Date(naive), timeZone))
  const corrected = new Date(naive - zoneOffsetMs(firstGuess, timeZone))

  return corrected
}

/** Is `instant` inside the recipient's permitted sending window? */
export function isWithinSendWindow(
  instant: Date,
  timeZone: string,
  window: SendWindow = DEFAULT_SEND_WINDOW
): boolean {
  if (!isValidTimeZone(timeZone)) {
    // Fail closed. An unknown zone means we cannot prove it is a decent hour
    // where the recipient is, so we do not send.
    return false
  }

  const parts = getZonedParts(instant, timeZone)
  const days = window.days ?? DEFAULT_SEND_WINDOW.days ?? []

  if (days.length > 0 && !days.includes(parts.weekday)) return false

  return parts.hour >= window.startHour && parts.hour < window.endHour
}

/**
 * Next instant at which sending is permitted.
 *
 * Returns `from` unchanged when already inside the window, so callers can use
 * this unconditionally.
 *
 * Throws on an invalid timezone rather than guessing, because scheduling into a
 * wrong zone is silent and only visible as complaints weeks later.
 */
export function nextSendWindowStart(
  from: Date,
  timeZone: string,
  window: SendWindow = DEFAULT_SEND_WINDOW
): Date {
  if (!isValidTimeZone(timeZone)) {
    throw new RangeError(`Unknown timezone: ${timeZone}`)
  }

  if (isWithinSendWindow(from, timeZone, window)) return from

  const days = window.days ?? DEFAULT_SEND_WINDOW.days ?? []
  const local = getZonedParts(from, timeZone)

  // Today's opening, if still ahead of us; otherwise start from tomorrow.
  const startToday = local.hour < window.startHour

  // 8 candidates covers any weekday mask plus the wrap into next week.
  for (let offset = startToday ? 0 : 1; offset <= 8; offset++) {
    // Step in local calendar days, then resolve to a UTC instant.
    const probe = new Date(Date.UTC(local.year, local.month - 1, local.day + offset, 12, 0, 0))
    const probeParts = getZonedParts(probe, timeZone)

    if (days.length > 0 && !days.includes(probeParts.weekday)) continue

    return zonedWallClockToUtc(timeZone, {
      year: probeParts.year,
      month: probeParts.month,
      day: probeParts.day,
      hour: window.startHour,
      minute: 0,
    })
  }

  // Unreachable for any non-empty day mask; explicit rather than silent.
  throw new RangeError('No permitted send window found within 8 days')
}

/**
 * Resolve which timezone governs a recipient.
 *
 * Precedence: the lead's own timezone, then the campaign default. Returns null
 * when neither is usable, which callers must treat as "do not send" rather than
 * defaulting to UTC.
 */
export function resolveRecipientTimeZone(
  leadTimeZone?: string | null,
  campaignTimeZone?: string | null
): string | null {
  for (const candidate of [leadTimeZone, campaignTimeZone]) {
    if (candidate && isValidTimeZone(candidate)) return candidate
  }
  return null
}
