import { describe, it, expect } from 'vitest'
import {
  isWithinSendWindow,
  nextSendWindowStart,
  getZonedParts,
  zonedWallClockToUtc,
  isValidTimeZone,
  resolveRecipientTimeZone,
  DEFAULT_SEND_WINDOW,
  type SendWindow,
} from '@/lib/compliance/sending-window'

const BUSINESS: SendWindow = { startHour: 9, endHour: 17, days: [1, 2, 3, 4, 5] }

describe('getZonedParts', () => {
  it('reads local wall clock, not server time', () => {
    // 2026-03-10T12:00:00Z
    const instant = new Date('2026-03-10T12:00:00Z')

    expect(getZonedParts(instant, 'UTC').hour).toBe(12)
    expect(getZonedParts(instant, 'Asia/Tokyo').hour).toBe(21)
    expect(getZonedParts(instant, 'America/New_York').hour).toBe(8)
  })

  it('reports weekday in the target zone', () => {
    // Monday 23:00 UTC is already Tuesday in Tokyo.
    const instant = new Date('2026-03-09T23:00:00Z')

    expect(getZonedParts(instant, 'UTC').weekday).toBe(1)
    expect(getZonedParts(instant, 'Asia/Tokyo').weekday).toBe(2)
  })

  it('normalises midnight to hour 0', () => {
    expect(getZonedParts(new Date('2026-03-10T00:00:00Z'), 'UTC').hour).toBe(0)
  })
})

describe('isWithinSendWindow', () => {
  // The original defect: a US-hosted worker mailing Tokyo at 03:00 local.
  it('rejects 03:00 local even when it is business hours on the server', () => {
    // 18:00 UTC Tuesday = 03:00 Wednesday in Tokyo.
    const instant = new Date('2026-03-10T18:00:00Z')

    expect(getZonedParts(instant, 'Asia/Tokyo').hour).toBe(3)
    expect(isWithinSendWindow(instant, 'Asia/Tokyo', BUSINESS)).toBe(false)
  })

  it('accepts mid-morning local time', () => {
    // 01:00 UTC Tuesday = 10:00 Tuesday in Tokyo.
    const instant = new Date('2026-03-10T01:00:00Z')

    expect(isWithinSendWindow(instant, 'Asia/Tokyo', BUSINESS)).toBe(true)
  })

  it('treats endHour as exclusive', () => {
    const at17 = new Date('2026-03-10T17:00:00Z')
    const at16 = new Date('2026-03-10T16:59:00Z')

    expect(isWithinSendWindow(at17, 'UTC', BUSINESS)).toBe(false)
    expect(isWithinSendWindow(at16, 'UTC', BUSINESS)).toBe(true)
  })

  it('excludes weekends by default', () => {
    // 2026-03-14 is a Saturday.
    const saturday = new Date('2026-03-14T12:00:00Z')
    expect(getZonedParts(saturday, 'UTC').weekday).toBe(6)
    expect(isWithinSendWindow(saturday, 'UTC', BUSINESS)).toBe(false)
  })

  it('honours a custom day mask', () => {
    const saturday = new Date('2026-03-14T12:00:00Z')
    expect(isWithinSendWindow(saturday, 'UTC', { ...BUSINESS, days: [6] })).toBe(true)
  })

  // An unknown zone must not degrade to UTC.
  it('fails closed on an invalid timezone', () => {
    const instant = new Date('2026-03-10T12:00:00Z')
    expect(isWithinSendWindow(instant, 'Not/AZone', BUSINESS)).toBe(false)
  })
})

describe('nextSendWindowStart', () => {
  it('returns the input unchanged when already inside the window', () => {
    const inside = new Date('2026-03-10T10:00:00Z')
    expect(nextSendWindowStart(inside, 'UTC', BUSINESS).toISOString()).toBe(inside.toISOString())
  })

  it('advances to 09:00 local the same day when it is too early', () => {
    const tooEarly = new Date('2026-03-10T05:00:00Z') // 05:00 UTC Tuesday
    const next = nextSendWindowStart(tooEarly, 'UTC', BUSINESS)

    expect(getZonedParts(next, 'UTC').hour).toBe(9)
    expect(getZonedParts(next, 'UTC').day).toBe(10)
  })

  it('rolls to the next day when the window has closed', () => {
    const tooLate = new Date('2026-03-10T20:00:00Z') // 20:00 Tuesday
    const next = nextSendWindowStart(tooLate, 'UTC', BUSINESS)

    expect(getZonedParts(next, 'UTC').day).toBe(11)
    expect(getZonedParts(next, 'UTC').hour).toBe(9)
  })

  it('skips the weekend', () => {
    const fridayEvening = new Date('2026-03-13T20:00:00Z') // Friday
    const next = nextSendWindowStart(fridayEvening, 'UTC', BUSINESS)

    // Monday the 16th.
    expect(getZonedParts(next, 'UTC').weekday).toBe(1)
    expect(getZonedParts(next, 'UTC').day).toBe(16)
    expect(getZonedParts(next, 'UTC').hour).toBe(9)
  })

  it('lands on 09:00 local in a non-UTC zone', () => {
    // 2026-03-11T00:00 UTC is 20:00 on the 10th in New York (EDT, UTC-4), so
    // the window has closed and this must roll to 09:00 on the 11th.
    // Note 20:00 UTC would NOT work here: that is 16:00 EDT, still inside the
    // window, and returning it unchanged would be correct behaviour.
    const late = new Date('2026-03-11T00:00:00Z')
    const next = nextSendWindowStart(late, 'America/New_York', BUSINESS)

    const parts = getZonedParts(next, 'America/New_York')
    expect(parts.hour).toBe(9)
    expect(parts.day).toBe(11)
  })

  it('leaves a late-afternoon local time alone when still inside the window', () => {
    // 20:00 UTC = 16:00 EDT, inside 9-17.
    const inside = new Date('2026-03-10T20:00:00Z')

    expect(getZonedParts(inside, 'America/New_York').hour).toBe(16)
    expect(nextSendWindowStart(inside, 'America/New_York', BUSINESS).toISOString()).toBe(
      inside.toISOString()
    )
  })

  it('throws rather than guessing on an invalid timezone', () => {
    expect(() => nextSendWindowStart(new Date(), 'Not/AZone', BUSINESS)).toThrow(RangeError)
  })
})

describe('DST correctness', () => {
  // US DST began 2026-03-08. A naive single-pass offset lands an hour out.
  it('lands on 09:00 local the day after a spring-forward transition', () => {
    const before = new Date('2026-03-09T02:00:00Z')
    const next = nextSendWindowStart(before, 'America/New_York', BUSINESS)

    expect(getZonedParts(next, 'America/New_York').hour).toBe(9)
  })

  it('lands on 09:00 local across a southern-hemisphere transition', () => {
    // Australia moves the opposite direction in April.
    const instant = new Date('2026-04-06T20:00:00Z')
    const next = nextSendWindowStart(instant, 'Australia/Sydney', BUSINESS)

    expect(getZonedParts(next, 'Australia/Sydney').hour).toBe(9)
  })

  it('handles a half-hour-offset zone', () => {
    const instant = new Date('2026-03-10T20:00:00Z')
    const next = nextSendWindowStart(instant, 'Asia/Kolkata', BUSINESS)

    const parts = getZonedParts(next, 'Asia/Kolkata')
    expect(parts.hour).toBe(9)
    expect(parts.minute).toBe(0)
  })
})

describe('zonedWallClockToUtc', () => {
  it('round-trips through getZonedParts', () => {
    const utc = zonedWallClockToUtc('Asia/Tokyo', {
      year: 2026,
      month: 6,
      day: 15,
      hour: 9,
    })

    const parts = getZonedParts(utc, 'Asia/Tokyo')
    expect(parts.hour).toBe(9)
    expect(parts.day).toBe(15)
  })
})

describe('isValidTimeZone', () => {
  it.each(['UTC', 'America/New_York', 'Asia/Tokyo', 'Australia/Sydney'])('accepts %s', (tz) => {
    expect(isValidTimeZone(tz)).toBe(true)
  })

  it.each(['', 'Not/AZone', 'Mars/Olympus'])('rejects %s', (tz) => {
    expect(isValidTimeZone(tz)).toBe(false)
  })
})

describe('resolveRecipientTimeZone', () => {
  it('prefers the lead timezone', () => {
    expect(resolveRecipientTimeZone('Asia/Tokyo', 'UTC')).toBe('Asia/Tokyo')
  })

  it('falls back to the campaign timezone', () => {
    expect(resolveRecipientTimeZone(null, 'America/New_York')).toBe('America/New_York')
  })

  it('skips an invalid lead timezone', () => {
    expect(resolveRecipientTimeZone('Not/AZone', 'UTC')).toBe('UTC')
  })

  // Never silently default to UTC — that is the original bug.
  it('returns null when neither is usable', () => {
    expect(resolveRecipientTimeZone(null, null)).toBeNull()
    expect(resolveRecipientTimeZone('Not/AZone', 'Also/Bad')).toBeNull()
  })
})

describe('DEFAULT_SEND_WINDOW', () => {
  it('is business hours, weekdays only', () => {
    expect(DEFAULT_SEND_WINDOW.startHour).toBe(9)
    expect(DEFAULT_SEND_WINDOW.endHour).toBe(17)
    expect(DEFAULT_SEND_WINDOW.days).toEqual([1, 2, 3, 4, 5])
  })
})
