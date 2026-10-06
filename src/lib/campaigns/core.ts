import { z } from 'zod'
import { DEFAULT_CAMPAIGN_SETTINGS } from './types'

export const campaignStatus = z.enum(['draft', 'active', 'paused', 'completed', 'archived'])
const providerIds = z.array(z.string().trim().min(1).max(200)).max(100).transform(ids => [...new Set(ids)])
const uuidIds = z.array(z.string().uuid()).max(1000).transform(ids => [...new Set(ids)])
export const settingsInput = z.object({
  dailyLimit: z.number().int().min(1).max(10000).optional(),
  sendingWindowStart: z.number().int().min(0).max(23).optional(),
  sendingWindowEnd: z.number().int().min(1).max(24).optional(),
  timezone: z.string().refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false } }).optional(),
  sendingDays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  skipWeekends: z.boolean().optional(), trackOpens: z.literal(false, { error: 'Open tracking is not available' }).optional(), trackClicks: z.literal(false, { error: 'Click tracking is not available' }).optional(),
  unsubscribeLink: z.literal(true).optional(), stopOnReply: z.literal(true).optional(), stopOnBounce: z.literal(true).optional(),
  abTestEnabled: z.literal(false).optional(),
  abTestWinnerCriteria: z.enum(['open_rate', 'reply_rate', 'click_rate']).optional(),
  abTestDuration: z.number().int().positive().max(720).optional(),
}).strict().refine(s => s.sendingWindowStart === undefined || s.sendingWindowEnd === undefined || s.sendingWindowStart < s.sendingWindowEnd, 'Sending window must end after it starts')
export const campaignInput = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.enum(['cold_email', 'follow_up', 'nurture', 'announcement']).optional(),
  settings: settingsInput.optional(),
  leadListIds: uuidIds.optional(), mailboxIds: providerIds.optional(),
}).strict()
export const campaignPatch = campaignInput.partial().extend({ expectedUpdatedAt: z.string().datetime({ offset: true }) }).strict()
export const variantInput = z.object({
  id: z.string().min(1).max(200), name: z.string().min(1).max(100), weight: z.literal(100),
  subject: z.string().trim().min(1).max(998), body: z.string().min(1).max(100000),
  bodyText: z.string().max(100000).nullable().optional(), isPlainText: z.boolean(),
}).strict()
export const sequenceInput = z.object({
  expectedUpdatedAt: z.string().datetime({ offset: true }),
  steps: z.array(z.object({
    id: z.string().min(1).max(200), order: z.number().int().positive().max(100), type: z.literal('email'),
    delayDays: z.number().int().min(0).max(365), delayHours: z.number().int().min(0).max(23),
    condition: z.enum(['always', 'not_opened', 'not_replied', 'not_clicked']),
    variants: z.array(variantInput).length(1, 'Multiple variants are not supported by the current sequence schema'),
  }).strict()).max(100),
}).strict().refine(input => new Set(input.steps.map(s => s.order)).size === input.steps.length, 'Duplicate sequence order')
export const enrollmentInput = z.object({ leadIds: uuidIds.optional(), listIds: uuidIds.optional() }).strict()
  .refine(input => (input.leadIds?.length ?? 0) + (input.listIds?.length ?? 0) > 0, 'Select leads or lists')
export const campaignRow = z.object({
  id: z.string(), organization_id: z.string().nullable(), name: z.string(), status: campaignStatus.nullable(),
  settings: z.record(z.string(), z.unknown()).nullable(), stats: z.record(z.string(), z.unknown()).nullable(),
  created_at: z.string().nullable(), updated_at: z.string().nullable(),
})
export type CampaignRow = z.infer<typeof campaignRow>

/**
 * Safety switches that are mandatory in the current transport. Historical rows
 * may store `false`; normalization repairs them so the editable settings and
 * save payload always satisfy the server's literal-`true` policy.
 */
export const MANDATORY_DELIVERABILITY_SETTINGS = {
  unsubscribeLink: true,
  stopOnReply: true,
  stopOnBounce: true,
} as const

export function normalizeCampaignSettings(settings: Record<string, unknown>) {
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  const legacyDays = z.array(z.enum(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'])).safeParse(settings.send_days)
  const config = Object.fromEntries(Object.entries(settings).filter(([key]) => key in DEFAULT_CAMPAIGN_SETTINGS || ['sendingDays', 'abTestWinnerCriteria', 'abTestDuration'].includes(key)))
  return {
    ...DEFAULT_CAMPAIGN_SETTINGS,
    dailyLimit: settings.dailyLimit ?? settings.daily_limit ?? DEFAULT_CAMPAIGN_SETTINGS.dailyLimit,
    sendingWindowStart: settings.sendingWindowStart ?? settings.send_hours_start ?? DEFAULT_CAMPAIGN_SETTINGS.sendingWindowStart,
    sendingWindowEnd: settings.sendingWindowEnd ?? settings.send_hours_end ?? DEFAULT_CAMPAIGN_SETTINGS.sendingWindowEnd,
    skipWeekends: settings.skipWeekends ?? (legacyDays.success ? !legacyDays.data.some(day => day === 'sun' || day === 'sat') : DEFAULT_CAMPAIGN_SETTINGS.skipWeekends),
    sendingDays: settings.sendingDays ?? (legacyDays.success ? legacyDays.data.map(day => days.indexOf(day)) : [1, 2, 3, 4, 5]),
    ...config,
    trackOpens: false, trackClicks: false, abTestEnabled: false,
    ...MANDATORY_DELIVERABILITY_SETTINGS,
  }
}
const uiStats = z.object({
  totalLeads: z.number(), contacted: z.number(), opened: z.number(), clicked: z.number(), replied: z.number(),
  bounced: z.number(), unsubscribed: z.number(), openRate: z.number(), clickRate: z.number(), replyRate: z.number(), bounceRate: z.number(),
})
export function campaignFromRow(row: CampaignRow) {
  const settings = row.settings ?? {}
  const parsedStats = uiStats.safeParse(row.stats)
  return {
    id: row.id, organizationId: row.organization_id, name: row.name, status: row.status ?? 'draft',
    type: typeof settings.type === 'string' ? settings.type : 'cold_email',
    settings: normalizeCampaignSettings(settings), stats: parsedStats.success ? parsedStats.data : null, storedStats: row.stats,
    statsEvidence: row.stats && Object.keys(row.stats).length ? 'stored_totals_unverified' : 'unknown',
    leadListIds: z.array(z.string()).catch([]).parse(settings.leadListIds),
    mailboxIds: z.array(z.string()).catch([]).parse(settings.mailboxIds),
    createdAt: row.created_at, updatedAt: row.updated_at,
  }
}
export const sequenceRow = z.object({
  id: z.string(), step_number: z.number().int(), subject: z.string(), body_html: z.string(), body_text: z.string().nullable(),
  delay_days: z.number().nullable(), delay_hours: z.number().nullable(), condition_type: z.string().nullable(),
})
export function sequenceFromRow(row: z.infer<typeof sequenceRow>) {
  const plain = !row.body_html && row.body_text !== null
  return {
    id: row.id, order: row.step_number, type: 'email' as const, delayDays: row.delay_days ?? 0, delayHours: row.delay_hours ?? 0,
    condition: row.condition_type ?? 'always',
    variants: [{ id: `var_${row.id}`, name: 'Version A', weight: 100, subject: row.subject,
      body: plain ? row.body_text ?? '' : row.body_html, bodyText: row.body_text, isPlainText: plain }],
  }
}
export function sequenceToRows(input: z.infer<typeof sequenceInput>) {
  return input.steps.toSorted((a, b) => a.order - b.order).map((step, index) => {
    const variant = variantInput.parse(step.variants[0])
    return { step_number: index + 1, subject: variant.subject,
      body_html: variant.isPlainText ? '' : variant.body,
      body_text: variant.isPlainText ? variant.body : variant.bodyText ?? null,
      delay_days: step.delayDays, delay_hours: step.delayHours, condition_type: step.condition }
  })
}
