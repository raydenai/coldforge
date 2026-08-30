import { addJob } from '@/lib/queue'
import { nextSendWindowStart, DEFAULT_SEND_WINDOW } from '@/lib/compliance/sending-window'

export interface ScheduledEmail {
  to: string
  from: string
  subject: string
  body: string
  scheduledAt: Date
  timezone: string
  campaignId?: string
  leadId?: string
}

export async function scheduleEmail(email: ScheduledEmail): Promise<string> {
  const delay = email.scheduledAt.getTime() - Date.now()
  const job = await addJob('EMAIL_SEND', 'scheduled-email', email, { delay: Math.max(0, delay) })
  return job.id || ''
}

/**
 * Next instant at which sending is permitted, in the RECIPIENT's timezone.
 *
 * The previous implementation accepted a timezone and ignored it, computing
 * hours from `now.getHours()` — the server's wall clock. A recipient in
 * Asia/Tokyo would be mailed at 03:00 local from a US-hosted worker. Quiet hours
 * are a policy control, so that was a compliance defect, not just a
 * deliverability one.
 *
 * Throws on an unknown timezone rather than falling back to server-local time,
 * because that fallback is precisely the original bug and it fails silently.
 */
export function getNextSendWindow(
  timezone: string,
  preferredHours = { start: 9, end: 17 },
  from: Date = new Date()
): Date {
  return nextSendWindowStart(from, timezone, {
    startHour: preferredHours.start,
    endHour: preferredHours.end,
    days: DEFAULT_SEND_WINDOW.days,
  })
}

export async function scheduleMultiple(emails: ScheduledEmail[], spreadMinutes = 60): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < emails.length; i++) {
    const baseEmail = emails[i]
    if (!baseEmail) continue
    const email: ScheduledEmail = {
      ...baseEmail,
      scheduledAt: new Date(baseEmail.scheduledAt.getTime() + i * (spreadMinutes * 60000 / emails.length)),
    }
    ids.push(await scheduleEmail(email))
  }
  return ids
}
