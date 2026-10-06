import { z } from 'zod'
import type { Json } from '@/types/database'
const jsonValueSchema: z.ZodType<Json> = z.lazy(() => z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]))

// ============================================================================
// Common Schemas
// ============================================================================

/** Pagination schema for list endpoints */
export const paginationSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
})

/** UUID validation */
export const uuidSchema = z.string().uuid()

/** Email validation */
export const emailSchema = z.string().email().max(255)

/** Timestamp schema */
export const timestampSchema = z.string().datetime().optional()

// ============================================================================
// Campaign Schemas
// ============================================================================

/** Campaign status enum */
export const campaignStatusSchema = z.enum([
  'draft',
  'active',
  'paused',
  'completed',
  'archived',
])

/** Campaign type enum */
export const campaignTypeSchema = z.enum([
  'cold_email',
  'follow_up',
  'nurture',
  'announcement',
])

/** A/B test winner criteria */
export const abTestWinnerCriteriaSchema = z.enum([
  'open_rate',
  'reply_rate',
  'click_rate',
])

/** Campaign settings schema */
export const campaignSettingsSchema = z.object({
  dailyLimit: z.number().int().min(1).max(1000).default(50),
  sendingWindowStart: z.number().int().min(0).max(23).default(9),
  sendingWindowEnd: z.number().int().min(0).max(23).default(17),
  timezone: z.string().default('America/New_York'),
  skipWeekends: z.boolean().default(true),
  trackOpens: z.boolean().default(true),
  trackClicks: z.boolean().default(true),
  unsubscribeLink: z.boolean().default(true),
  stopOnReply: z.boolean().default(true),
  stopOnBounce: z.boolean().default(true),
  abTestEnabled: z.boolean().default(false),
  abTestWinnerCriteria: abTestWinnerCriteriaSchema.optional(),
  abTestDuration: z.number().int().min(1).max(168).optional(), // hours (max 1 week)
})

/** Create campaign request schema */
export const createCampaignSchema = z.object({
  name: z.string().min(1, 'Campaign name is required').max(255),
  type: campaignTypeSchema.default('cold_email'),
  settings: campaignSettingsSchema.partial().optional(),
  leadListIds: z.array(uuidSchema).optional(),
  mailboxIds: z.array(uuidSchema).optional(),
})

/** Update campaign request schema */
export const updateCampaignSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  type: campaignTypeSchema.optional(),
  settings: campaignSettingsSchema.partial().optional(),
  leadListIds: z.array(uuidSchema).optional(),
  mailboxIds: z.array(uuidSchema).optional(),
})

/** Campaign stats schema */
export const campaignStatsSchema = z.object({
  totalLeads: z.number().int().min(0),
  contacted: z.number().int().min(0),
  opened: z.number().int().min(0),
  clicked: z.number().int().min(0),
  replied: z.number().int().min(0),
  bounced: z.number().int().min(0),
  unsubscribed: z.number().int().min(0),
  openRate: z.number().min(0).max(100),
  clickRate: z.number().min(0).max(100),
  replyRate: z.number().min(0).max(100),
  bounceRate: z.number().min(0).max(100),
})

/** Campaign response schema */
export const campaignResponseSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  status: campaignStatusSchema,
  type: campaignTypeSchema,
  settings: campaignSettingsSchema,
  stats: campaignStatsSchema,
  leadListIds: z.array(uuidSchema),
  mailboxIds: z.array(uuidSchema),
  scheduleId: uuidSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  pausedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
})

/** List campaigns query params */
export const listCampaignsQuerySchema = paginationSchema.extend({
  status: z.string().transform(val => val.split(',').filter(Boolean)).optional(),
})

// ============================================================================
// Lead Schemas
// ============================================================================

/** Lead status enum */
export const leadStatusSchema = z.enum([
  'active',
  'contacted',
  'replied',
  'bounced',
  'unsubscribed',
  'invalid',
])

/** Lead validation status enum */
export const leadValidationStatusSchema = z.enum([
  'pending',
  'valid',
  'invalid',
  'risky',
  'unknown',
])

/** Create lead request schema */
export const createLeadSchema = z.object({
  email: emailSchema,
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  company: z.string().max(255).optional(),
  title: z.string().max(255).optional(),
  phone: z.string().max(50).optional(),
  linkedinUrl: z.string().url().max(500).optional().or(z.literal('')),
  listId: uuidSchema.optional(),
  customFields: z.record(z.string(), jsonValueSchema).optional(),
})

/** Update lead request schema */
export const updateLeadSchema = z.object({
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  company: z.string().max(255).optional(),
  title: z.string().max(255).optional(),
  phone: z.string().max(50).optional(),
  linkedinUrl: z.string().url().max(500).optional().or(z.literal('')),
  listId: uuidSchema.nullable().optional(),
  customFields: z.record(z.string(), jsonValueSchema).optional(),
  status: leadStatusSchema.optional(),
})

/** Lead response schema */
export const leadResponseSchema = z.object({
  id: uuidSchema,
  email: emailSchema,
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  company: z.string().nullable(),
  title: z.string().nullable(),
  phone: z.string().nullable(),
  linkedinUrl: z.string().nullable(),
  customFields: z.record(z.string(), jsonValueSchema),
  listId: uuidSchema.nullable(),
  status: leadStatusSchema,
  validationStatus: leadValidationStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** List leads query params */
export const listLeadsQuerySchema = paginationSchema.extend({
  listId: uuidSchema.optional(),
})

// ============================================================================
// Email Account Schemas
// ============================================================================

/** Email provider enum */
export const emailProviderSchema = z.enum(['google', 'microsoft', 'smtp'])

/** Email account status enum */
export const emailAccountStatusSchema = z.enum(['active', 'paused', 'error', 'warming'])

/** Create email account request schema */
export const createEmailAccountSchema = z.object({
  email: emailSchema,
  provider: emailProviderSchema,
  display_name: z.string().max(255).optional(),
  smtp_host: z.string().max(255).optional(),
  smtp_port: z.number().int().min(1).max(65535).optional(),
  smtp_user: z.string().max(255).optional(),
  smtp_password: z.string().max(500).optional(),
  imap_host: z.string().max(255).optional(),
  imap_port: z.number().int().min(1).max(65535).default(993).optional(),
  oauth_tokens: z.object({
    access_token: z.string(),
    refresh_token: z.string().optional(),
    expires_at: z.number().optional(),
  }).optional(),
  daily_limit: z.number().int().min(1).max(500).default(50),
}).refine(data => {
  // If provider is SMTP, require SMTP fields
  if (data.provider === 'smtp') {
    return data.smtp_host && data.smtp_port && data.smtp_user && data.smtp_password
  }
  return true
}, {
  message: 'SMTP configuration is required for SMTP provider',
  path: ['smtp_host'],
})

/** Update email account request schema */
export const updateEmailAccountSchema = z.object({
  display_name: z.string().max(255).optional(),
  daily_limit: z.number().int().min(1).max(500).optional(),
  status: emailAccountStatusSchema.optional(),
  warmup_enabled: z.boolean().optional(),
})

/** Email account response schema */
export const emailAccountResponseSchema = z.object({
  id: uuidSchema,
  email: emailSchema,
  provider: emailProviderSchema,
  display_name: z.string().nullable(),
  daily_limit: z.number(),
  status: emailAccountStatusSchema,
  warmup_enabled: z.boolean(),
  health_score: z.number().min(0).max(100),
  created_at: z.string(),
  updated_at: z.string().optional(),
  is_active: z.boolean().optional(),
})

// ============================================================================
// Domain Schemas
// ============================================================================

/** Domain registrar enum */
export const domainRegistrarSchema = z.enum([
  'cloudflare',
  'namecheap',
  'porkbun',
  'manual',
])

/** Domain health status enum */
export const domainHealthStatusSchema = z.enum([
  'healthy',
  'warning',
  'error',
  'pending',
])

/** Create domain request schema */
export const createDomainSchema = z.object({
  domain: z.string()
    .min(1, 'Domain is required')
    .max(255)
    .regex(
      /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.[a-zA-Z]{2,}$/,
      'Invalid domain format'
    )
    .transform(val => val.toLowerCase()),
  dns_provider: z.string().max(100).optional(),
})

/** Update domain request schema */
export const updateDomainSchema = z.object({
  dns_provider: z.string().max(100).optional(),
})

/** Domain response schema */
export const domainResponseSchema = z.object({
  id: uuidSchema,
  domain: z.string(),
  registrar: domainRegistrarSchema.nullable(),
  dns_provider: z.string().nullable(),
  spf_configured: z.boolean(),
  dkim_configured: z.boolean(),
  dkim_selector: z.string().nullable(),
  dmarc_configured: z.boolean(),
  bimi_configured: z.boolean(),
  health_status: domainHealthStatusSchema,
  last_health_check: z.string().nullable(),
  auto_purchased: z.boolean(),
  purchase_price: z.number().nullable(),
  expires_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})

// ============================================================================
// Mailbox Schemas
// ============================================================================

/** Mailbox status enum */
export const mailboxStatusSchema = z.enum([
  'active',
  'suspended',
  'pending',
  'error',
])

/** Mailbox provider enum */
export const mailboxProviderSchema = z.enum([
  'custom_smtp',
  'google_workspace',
  'microsoft_365',
])

/** Create mailbox request schema */
export const createMailboxSchema = z.object({
  domainId: uuidSchema,
  email: emailSchema,
  firstName: z.string().min(1, 'First name is required').max(100),
  lastName: z.string().min(1, 'Last name is required').max(100),
  password: z.string().min(8).max(128).optional(),
  provider: mailboxProviderSchema.default('custom_smtp'),
  warmupEnabled: z.boolean().default(false),
  sendingQuota: z.number().int().min(1).max(500).default(50),
})

/** Update mailbox request schema */
export const updateMailboxSchema = z.object({
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  status: mailboxStatusSchema.optional(),
  warmupEnabled: z.boolean().optional(),
  sendingQuota: z.number().int().min(1).max(500).optional(),
})

/** Mailbox response schema */
export const mailboxResponseSchema = z.object({
  id: uuidSchema,
  email: emailSchema,
  domain: z.string(),
  domainId: uuidSchema,
  provider: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  displayName: z.string(),
  status: mailboxStatusSchema,
  sendingQuota: z.number(),
  emailsSentToday: z.number(),
  warmupEnabled: z.boolean(),
  warmupStage: z.number(),
  lastActivity: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** List mailboxes query params */
export const listMailboxesQuerySchema = paginationSchema.extend({
  domain_id: uuidSchema.optional(),
  status: mailboxStatusSchema.optional(),
})

// ============================================================================
// Inbox Schemas
// ============================================================================

/** Reply category enum */
export const replyCategorySchema = z.enum([
  'interested',
  'not_interested',
  'out_of_office',
  'meeting_request',
  'unsubscribe',
  'question',
  'bounce',
  'auto_reply',
  'other',
])

/** Reply sentiment enum */
export const replySentimentSchema = z.enum([
  'positive',
  'negative',
  'neutral',
  'mixed',
])

/** Reply status enum */
export const replyStatusSchema = z.enum([
  'unread',
  'read',
  'replied',
  'archived',
])

/** Thread status enum */
export const threadStatusSchema = z.enum([
  'active',
  'resolved',
  'archived',
])

/** List inbox query params */
export const listInboxQuerySchema = paginationSchema.extend({
  category: replyCategorySchema.optional(),
  status: threadStatusSchema.optional(),
  search: z.string().max(255).optional(),
  unreadOnly: z.coerce.boolean().default(false),
})

/** List replies query params */
export const listRepliesQuerySchema = paginationSchema.extend({
  campaignId: uuidSchema.optional(),
  mailboxId: uuidSchema.optional(),
  category: replyCategorySchema.optional(),
  sentiment: replySentimentSchema.optional(),
  status: replyStatusSchema.optional(),
  search: z.string().max(255).optional(),
})

/** List threads query params */
export const listThreadsQuerySchema = paginationSchema.extend({
  status: threadStatusSchema.optional(),
  category: replyCategorySchema.optional(),
  campaignId: uuidSchema.optional(),
  search: z.string().max(255).optional(),
})

/** Create reply request schema (from webhook/email receive) */
export const createReplySchema = z.object({
  organizationId: uuidSchema,
  campaignId: uuidSchema.nullable().optional(),
  leadId: uuidSchema.nullable().optional(),
  mailboxId: uuidSchema,
  threadId: uuidSchema,
  messageId: z.string().min(1).max(500),
  inReplyTo: z.string().max(500).optional(),
  from: emailSchema,
  fromName: z.string().max(255).nullable().optional(),
  to: emailSchema,
  subject: z.string().max(500),
  bodyText: z.string().min(1),
  bodyHtml: z.string().nullable().optional(),
  receivedAt: timestampSchema,
})

/** Inbox bulk action schema */
export const inboxBulkActionSchema = z.object({
  action: z.enum(['mark_read', 'mark_unread', 'archive', 'resolve', 'unarchive']),
  threadIds: z.array(uuidSchema).optional(),
  replyIds: z.array(uuidSchema).optional(),
}).refine(
  data => (data.threadIds?.length ?? 0) > 0 || (data.replyIds?.length ?? 0) > 0,
  { message: 'Thread IDs or Reply IDs are required' }
)

// ============================================================================
// Warmup Schemas
// ============================================================================

/** Warmup action enum */
export const warmupActionSchema = z.enum(['enable', 'disable', 'update_config'])

/** Warmup config schema */
export const warmupConfigSchema = z.object({
  dailyEmailTarget: z.number().int().min(1).max(100).optional(),
  replyRate: z.number().min(0).max(100).optional(),
  sendingWindow: z.object({
    start: z.number().int().min(0).max(23),
    end: z.number().int().min(0).max(23),
  }).optional(),
  enableReplies: z.boolean().optional(),
  rampUpDays: z.number().int().min(1).max(90).optional(),
})

/** POST /api/warmup request schema */
export const warmupActionRequestSchema = z.object({
  action: warmupActionSchema,
  mailboxIds: z.array(uuidSchema).optional(),
  config: warmupConfigSchema.optional(),
}).refine(
  data => {
    // Enable/disable require mailboxIds
    if (['enable', 'disable'].includes(data.action)) {
      return data.mailboxIds && data.mailboxIds.length > 0
    }
    // update_config requires config
    if (data.action === 'update_config') {
      return data.config !== undefined
    }
    return true
  },
  {
    message: 'Invalid request: enable/disable require mailboxIds, update_config requires config',
  }
)

// ============================================================================
// Sending Queue Schemas
// ============================================================================

/** Email job status enum */
export const emailJobStatusSchema = z.enum([
  'pending',
  'scheduled',
  'sending',
  'sent',
  'failed',
  'cancelled',
  'bounced',
])

/** GET /api/sending/queue query params */
export const sendingQueueQuerySchema = paginationSchema.extend({
  campaignId: uuidSchema.optional(),
  status: z.string().transform(val => val.split(',').filter(Boolean)).optional(),
})

/** POST /api/sending/queue request schema */
export const createQueueJobsSchema = z.object({
  campaignId: uuidSchema,
  leadIds: z.array(uuidSchema).min(1, 'At least one lead ID is required'),
  sequenceStepId: uuidSchema,
  variantId: uuidSchema.optional(),
  scheduledAt: timestampSchema,
  priority: z.number().int().min(1).max(10).default(5),
})

/** DELETE /api/sending/queue request schema */
export const cancelQueueJobsSchema = z.object({
  jobIds: z.array(uuidSchema).optional(),
  campaignId: uuidSchema.optional(),
  cancelAll: z.boolean().default(false),
}).refine(
  data => data.jobIds?.length || data.campaignId || data.cancelAll,
  { message: 'Specify jobIds, campaignId, or cancelAll' }
)

// ============================================================================
// Analytics Schemas
// ============================================================================

/** Analytics period enum */
export const analyticsPeriodSchema = z.enum(['7d', '30d', '90d'])

/** GET /api/analytics query params */
export const analyticsQuerySchema = z.object({
  period: analyticsPeriodSchema.default('30d'),
  campaignId: uuidSchema.optional(),
})

/** GET /api/analytics/campaigns query params */
export const campaignAnalyticsQuerySchema = paginationSchema.extend({
  period: analyticsPeriodSchema.default('30d'),
  sortBy: z.enum(['sent', 'open_rate', 'reply_rate', 'click_rate']).default('sent'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
})

// ============================================================================
// Deliverability Schemas
// ============================================================================

/** Deliverability period enum */
export const deliverabilityPeriodSchema = z.enum(['7d', '30d', '90d'])

/** GET /api/deliverability query params */
export const deliverabilityQuerySchema = z.object({
  period: deliverabilityPeriodSchema.default('7d'),
  campaignId: uuidSchema.optional(),
})

// ============================================================================
// Billing Schemas
// ============================================================================

/** Plan tier enum */
export const planTierSchema = z.enum(['starter', 'growth', 'scale', 'enterprise'])

/** Billing interval enum */
export const billingIntervalSchema = z.enum(['month', 'year'])

/** POST /api/billing/checkout request schema */
export const checkoutRequestSchema = z.object({
  planTier: planTierSchema,
  interval: billingIntervalSchema,
})

// ============================================================================
// Settings Schemas
// ============================================================================

/** User role enum */
export const userRoleSchema = z.enum(['owner', 'admin', 'member'])

/** Update profile request schema */
export const updateProfileSchema = z.object({
  full_name: z.string().max(255).optional(),
  avatar_url: z.string().url().max(500).optional().or(z.literal('')),
  timezone: z.string().max(100).optional(),
})

/** Profile response schema */
export const profileResponseSchema = z.object({
  id: uuidSchema,
  email: emailSchema,
  full_name: z.string().nullable(),
  avatar_url: z.string().nullable(),
  role: userRoleSchema,
  timezone: z.string(),
})

// ============================================================================
// Generic API Response Schemas
// ============================================================================

/** Generic API error response */
export const apiErrorSchema = z.object({
  error: z.string(),
})

/** Generic success response */
export const apiSuccessSchema = z.object({
  success: z.boolean(),
})

/** Pagination response metadata */
export const paginationResponseSchema = z.object({
  page: z.number(),
  limit: z.number(),
  total: z.number(),
  totalPages: z.number(),
})

/**
 * Generic API response wrapper
 * Creates a typed response schema with data and optional error
 */
export const createApiResponseSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    data: dataSchema.optional(),
    error: z.string().nullable().optional(),
  })

/**
 * Generic list response wrapper
 * Creates a typed paginated list response
 */
export const createListResponseSchema = <T extends z.ZodTypeAny>(
  itemSchema: T,
  itemsKey: string = 'items'
) =>
  z.object({
    [itemsKey]: z.array(itemSchema),
    pagination: paginationResponseSchema,
  })

// ============================================================================
// Type Exports (inferred from schemas)
// ============================================================================

export type Pagination = z.infer<typeof paginationSchema>
export type CampaignStatus = z.infer<typeof campaignStatusSchema>
export type CampaignType = z.infer<typeof campaignTypeSchema>
export type CampaignSettings = z.infer<typeof campaignSettingsSchema>
export type CampaignStats = z.infer<typeof campaignStatsSchema>
export type CreateCampaignInput = z.infer<typeof createCampaignSchema>
export type UpdateCampaignInput = z.infer<typeof updateCampaignSchema>
export type CampaignResponse = z.infer<typeof campaignResponseSchema>

export type LeadStatus = z.infer<typeof leadStatusSchema>
export type LeadValidationStatus = z.infer<typeof leadValidationStatusSchema>
export type CreateLeadInput = z.infer<typeof createLeadSchema>
export type UpdateLeadInput = z.infer<typeof updateLeadSchema>
export type LeadResponse = z.infer<typeof leadResponseSchema>

export type EmailProvider = z.infer<typeof emailProviderSchema>
export type EmailAccountStatus = z.infer<typeof emailAccountStatusSchema>
export type CreateEmailAccountInput = z.infer<typeof createEmailAccountSchema>
export type UpdateEmailAccountInput = z.infer<typeof updateEmailAccountSchema>
export type EmailAccountResponse = z.infer<typeof emailAccountResponseSchema>

export type DomainRegistrar = z.infer<typeof domainRegistrarSchema>
export type DomainHealthStatus = z.infer<typeof domainHealthStatusSchema>
export type CreateDomainInput = z.infer<typeof createDomainSchema>
export type UpdateDomainInput = z.infer<typeof updateDomainSchema>
export type DomainResponse = z.infer<typeof domainResponseSchema>

export type MailboxStatus = z.infer<typeof mailboxStatusSchema>
export type MailboxProvider = z.infer<typeof mailboxProviderSchema>
export type CreateMailboxInput = z.infer<typeof createMailboxSchema>
export type UpdateMailboxInput = z.infer<typeof updateMailboxSchema>
export type MailboxResponse = z.infer<typeof mailboxResponseSchema>

export type ReplyCategory = z.infer<typeof replyCategorySchema>
export type ReplySentiment = z.infer<typeof replySentimentSchema>
export type ReplyStatus = z.infer<typeof replyStatusSchema>
export type ThreadStatus = z.infer<typeof threadStatusSchema>
export type InboxBulkAction = z.infer<typeof inboxBulkActionSchema>
export type ListRepliesQuery = z.infer<typeof listRepliesQuerySchema>
export type ListThreadsQuery = z.infer<typeof listThreadsQuerySchema>
export type CreateReplyInput = z.infer<typeof createReplySchema>

export type UserRole = z.infer<typeof userRoleSchema>
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>
export type ProfileResponse = z.infer<typeof profileResponseSchema>

export type WarmupAction = z.infer<typeof warmupActionSchema>
export type WarmupConfig = z.infer<typeof warmupConfigSchema>
export type WarmupActionRequest = z.infer<typeof warmupActionRequestSchema>

export type EmailJobStatus = z.infer<typeof emailJobStatusSchema>
export type CreateQueueJobsInput = z.infer<typeof createQueueJobsSchema>
export type CancelQueueJobsInput = z.infer<typeof cancelQueueJobsSchema>

export type AnalyticsPeriod = z.infer<typeof analyticsPeriodSchema>
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>
export type CampaignAnalyticsQuery = z.infer<typeof campaignAnalyticsQuerySchema>

export type DeliverabilityPeriod = z.infer<typeof deliverabilityPeriodSchema>
export type DeliverabilityQuery = z.infer<typeof deliverabilityQuerySchema>

export type PlanTier = z.infer<typeof planTierSchema>
export type BillingInterval = z.infer<typeof billingIntervalSchema>
export type CheckoutRequest = z.infer<typeof checkoutRequestSchema>

export type ApiError = z.infer<typeof apiErrorSchema>
export type ApiSuccess = z.infer<typeof apiSuccessSchema>
export type PaginationResponse = z.infer<typeof paginationResponseSchema>

// ============================================================================
// Inbox Sync Schemas
// ============================================================================

/** POST /api/inbox/sync request schema */
export const inboxSyncRequestSchema = z.object({
  accountIds: z.array(uuidSchema).optional(),
  syncAll: z.boolean().default(false),
  since: z.string().datetime().optional(),
  categorize: z.boolean().default(true),
}).refine(
  data => data.syncAll || (data.accountIds && data.accountIds.length > 0),
  { message: 'Either specify accountIds or set syncAll to true' }
)

/** GET /api/inbox/stats query params */
export const inboxStatsQuerySchema = z.object({
  accountId: uuidSchema.optional(),
  campaignId: uuidSchema.optional(),
  period: z.enum(['24h', '7d', '30d', '90d']).default('7d'),
})

export type InboxSyncRequest = z.infer<typeof inboxSyncRequestSchema>
export type InboxStatsQuery = z.infer<typeof inboxStatsQuerySchema>
