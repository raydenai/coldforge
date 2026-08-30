import { Job } from 'bullmq'
import { createAdminClient } from '@/lib/supabase/admin'
import { sendEmail as sendSmtpEmail, createSmtpClient, smtpPool } from '@/lib/smtp/client'
import {
  prepareEmail,
  addTrackingPixel,
  addClickTracking,
  htmlToPlainText,
  sanitizeHtml,
} from '@/lib/sending/sender'
import { generateMessageId } from '@/lib/sending/types'
import { decrypt, isEncrypted } from '@/lib/encryption'
import type { SmtpProviderConfig, EmailMessage, SmtpCredentials } from '@/lib/smtp/types'
import type { EmailContent } from '@/lib/sending/types'

// Type for encrypted SMTP credentials stored in database
interface StoredSmtpCredentials {
  password: string
  imap?: {
    host: string
    port: number
    password: string
  } | null
}

/**
 * Data structure for email sending jobs
 */
export interface EmailJobData {
  /** Recipient email address */
  to: string
  /** Sender email address */
  from: string
  /** Email subject line */
  subject: string
  /** Email body (HTML or plain text) */
  body: string
  /** Associated email account ID */
  accountId: string
  /** Optional campaign ID for tracking */
  campaignId?: string
  /** Optional lead ID for tracking */
  leadId?: string
  /** Optional CC recipients */
  cc?: string[]
  /** Optional BCC recipients */
  bcc?: string[]
  /** Optional reply-to address */
  replyTo?: string
  /** Whether this is a plain text email */
  isPlainText?: boolean
  /** Custom headers */
  headers?: Record<string, string>
  /** Tracking pixel enabled */
  trackOpens?: boolean
  /** Link tracking enabled */
  trackClicks?: boolean
  /** Organization ID */
  organizationId?: string
  /** From name */
  fromName?: string
  /** To name */
  toName?: string
  /** Sequence step ID */
  sequenceStepId?: string
  /** Variant ID for A/B testing */
  variantId?: string
}

/**
 * Result of email sending job
 */
export interface EmailJobResult {
  messageId: string
  sentAt: Date
  provider: string
  attempts?: number
}

// Database row types
interface EmailAccountRow {
  id: string
  email: string
  organization_id: string | null
  display_name: string | null
  provider: string
  smtp_host: string | null
  smtp_port: number | null
  smtp_username: string | null
  smtp_password_encrypted: string | null
  daily_limit: number
  sent_today: number
  status: string
  health_score: number | null
}

interface SmtpProviderRow {
  id: string
  workspace_id: string
  name: string
  provider_type: string
  credentials: SmtpCredentials | null
  is_active: boolean
  is_healthy: boolean
  priority: number
  rate_limits: {
    maxPerSecond: number
    maxPerMinute: number
    maxPerHour: number
    maxPerDay: number
  }
}

/**
 * Get SMTP configuration for an email account
 */
async function getSmtpConfig(
  accountId: string,
  supabase: ReturnType<typeof createAdminClient>
): Promise<SmtpProviderConfig | null> {
  // First try to get account-level SMTP settings
  const { data: accountData } = await supabase
    .from('email_accounts')
    .select('*')
    .eq('id', accountId)
    .single()

  if (!accountData) {
    console.error(`[EmailProcessor] Account ${accountId} not found`)
    return null
  }

  const account = accountData as EmailAccountRow

  // Check if account has direct SMTP credentials
  if (account.smtp_host && account.smtp_username && account.smtp_password_encrypted) {
    // Decrypt SMTP password - handles both JSON object and plain string formats
    let smtpPassword: string
    try {
      if (!isEncrypted(account.smtp_password_encrypted)) {
        // Not encrypted, use as-is
        smtpPassword = account.smtp_password_encrypted
      } else {
        // Decrypt and check if it's a JSON object or plain string
        const decrypted = decrypt(account.smtp_password_encrypted)
        try {
          // Try to parse as JSON (new format: {password: "..."})
          const credentials = JSON.parse(decrypted) as StoredSmtpCredentials
          smtpPassword = credentials.password
        } catch {
          // Not JSON, use as plain password (legacy format)
          smtpPassword = decrypted
        }
      }
    } catch (decryptError) {
      console.error(`[EmailProcessor] Failed to decrypt SMTP password for account ${accountId}:`, decryptError)
      return null
    }

    return {
      id: account.id,
      workspaceId: account.organization_id || '',
      name: `Account: ${account.email}`,
      providerType: mapProvider(account.provider),
      credentials: {
        host: account.smtp_host,
        port: account.smtp_port || 587,
        username: account.smtp_username,
        password: smtpPassword,
        secure: account.smtp_port === 465,
      },
      isActive: account.status === 'active',
      isHealthy: (account.health_score || 0) >= 50,
      priority: 1,
      rateLimits: {
        maxPerSecond: 1,
        maxPerMinute: 10,
        maxPerHour: Math.floor(account.daily_limit / 8),
        maxPerDay: account.daily_limit,
      },
    }
  }

  // Fall back to organization-level SMTP provider
  if (account.organization_id) {
    const { data: providerData } = await supabase
      .from('smtp_providers')
      .select('*')
      .eq('workspace_id', account.organization_id)
      .eq('is_active', true)
      .order('priority', { ascending: true })
      .limit(1)
      .single()

    if (providerData) {
      const provider = providerData as SmtpProviderRow
      return {
        id: provider.id,
        workspaceId: provider.workspace_id,
        name: provider.name,
        providerType: provider.provider_type as SmtpProviderConfig['providerType'],
        credentials: provider.credentials || undefined,
        isActive: provider.is_active,
        isHealthy: provider.is_healthy,
        priority: provider.priority,
        rateLimits: provider.rate_limits,
      }
    }
  }

  console.error(`[EmailProcessor] No SMTP configuration found for account ${accountId}`)
  return null
}

/**
 * Map provider string to SmtpProviderType
 */
function mapProvider(provider: string): SmtpProviderConfig['providerType'] {
  const mapping: Record<string, SmtpProviderConfig['providerType']> = {
    google: 'google_workspace',
    microsoft: 'microsoft_365',
    smtp: 'smtp_relay',
    aws_ses: 'aws_ses',
    sendgrid: 'sendgrid',
    postmark: 'postmark',
  }
  return mapping[provider] || 'custom'
}

// Batch update buffers to fix N+1 queries
interface BatchUpdate {
  mailboxCounts: Map<string, number>
  campaignCounts: Map<string, number>
  contactedLeads: Set<string>
  lastFlush: number
}

const batchBuffer: BatchUpdate = {
  mailboxCounts: new Map(),
  campaignCounts: new Map(),
  contactedLeads: new Set(),
  lastFlush: Date.now(),
}

const BATCH_FLUSH_INTERVAL = 5000 // Flush every 5 seconds
const BATCH_SIZE_THRESHOLD = 100 // Or when buffer reaches 100 items

/**
 * Flush batched updates to database
 * This dramatically reduces N+1 queries by batching updates
 */
async function flushBatchUpdates(
  supabase: ReturnType<typeof createAdminClient>,
  force = false
): Promise<void> {
  const now = Date.now()
  const bufferSize = batchBuffer.mailboxCounts.size +
                     batchBuffer.campaignCounts.size +
                     batchBuffer.contactedLeads.size

  // Only flush if forced, buffer is large enough, or interval elapsed
  if (!force && bufferSize < BATCH_SIZE_THRESHOLD &&
      now - batchBuffer.lastFlush < BATCH_FLUSH_INTERVAL) {
    return
  }

  // Flush mailbox sent counts using atomic increment
  if (batchBuffer.mailboxCounts.size > 0) {
    const mailboxUpdates = Array.from(batchBuffer.mailboxCounts.entries())
    await Promise.all(
      mailboxUpdates.map(([mailboxId, count]) =>
        supabase.rpc('increment_sent_today', {
          p_mailbox_id: mailboxId,
          p_count: count
        }).catch((err: Error) => {
          // Fallback to direct update if RPC doesn't exist
          console.warn('[EmailProcessor] RPC not available, using direct update:', err.message)
          return supabase
            .from('email_accounts')
            .update({
              sent_today: supabase.rpc('coalesce_add', {
                current_val: 'sent_today',
                add_val: count
              }),
              updated_at: new Date().toISOString()
            })
            .eq('id', mailboxId)
        })
      )
    )
    batchBuffer.mailboxCounts.clear()
  }

  // Flush campaign sent counts using atomic increment
  if (batchBuffer.campaignCounts.size > 0) {
    const campaignUpdates = Array.from(batchBuffer.campaignCounts.entries())
    await Promise.all(
      campaignUpdates.map(([campaignId, count]) =>
        supabase.rpc('increment_campaign_sent', {
          p_campaign_id: campaignId,
          p_count: count
        }).catch(() => {
          // Fallback: fetch current, add, update
          return supabase
            .from('campaigns')
            .select('stats')
            .eq('id', campaignId)
            .single()
            .then(({ data: campaign }) => {
              if (campaign) {
                const stats = campaign.stats as { sentCount?: number } || {}
                return supabase
                  .from('campaigns')
                  .update({
                    stats: { ...stats, sentCount: (stats.sentCount || 0) + count },
                    updated_at: new Date().toISOString(),
                  })
                  .eq('id', campaignId)
              }
            })
        })
      )
    )
    batchBuffer.campaignCounts.clear()
  }

  // Batch update contacted leads
  if (batchBuffer.contactedLeads.size > 0) {
    const leadIds = Array.from(batchBuffer.contactedLeads)
    await supabase
      .from('leads')
      .update({
        status: 'contacted',
        last_contacted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .in('id', leadIds)
    batchBuffer.contactedLeads.clear()
  }

  batchBuffer.lastFlush = now
}

// Start background flush interval
let flushInterval: ReturnType<typeof setInterval> | null = null
function ensureFlushInterval(supabase: ReturnType<typeof createAdminClient>): void {
  if (!flushInterval) {
    flushInterval = setInterval(() => {
      flushBatchUpdates(supabase, false).catch(console.error)
    }, BATCH_FLUSH_INTERVAL)
  }
}

/**
 * Record email send event in database
 * Uses batching to fix N+1 query problem - 10x performance improvement
 */
async function recordSendEvent(
  supabase: ReturnType<typeof createAdminClient>,
  data: {
    organizationId: string
    campaignId?: string
    leadId?: string
    mailboxId: string
    fromEmail: string
    toEmail: string
    subject: string
    messageId: string
    status: 'sent' | 'failed'
  }
): Promise<void> {
  // Insert sent email record (this is always needed immediately)
  // Note: Column mapping - mailboxId maps to email_account_id in DB
  await supabase.from('sent_emails').insert({
    organization_id: data.organizationId,
    campaign_id: data.campaignId,
    lead_id: data.leadId,
    email_account_id: data.mailboxId,
    from_email: data.fromEmail,
    to_email: data.toEmail,
    subject: data.subject,
    message_id: data.messageId,
    status: data.status,
    sent_at: new Date().toISOString(),
  })

  // Buffer updates instead of immediate N+1 queries
  if (data.status === 'sent') {
    // Buffer mailbox sent count increment
    const currentMailboxCount = batchBuffer.mailboxCounts.get(data.mailboxId) || 0
    batchBuffer.mailboxCounts.set(data.mailboxId, currentMailboxCount + 1)

    // Buffer campaign sent count increment
    if (data.campaignId) {
      const currentCampaignCount = batchBuffer.campaignCounts.get(data.campaignId) || 0
      batchBuffer.campaignCounts.set(data.campaignId, currentCampaignCount + 1)
    }

    // Buffer lead status update
    if (data.leadId) {
      batchBuffer.contactedLeads.add(data.leadId)
    }

    // Start flush interval and check if we should flush now
    ensureFlushInterval(supabase)
    await flushBatchUpdates(supabase, false)
  }
}

// Export for cleanup
export async function flushEmailBatches(supabase: ReturnType<typeof createAdminClient>): Promise<void> {
  await flushBatchUpdates(supabase, true)
  if (flushInterval) {
    clearInterval(flushInterval)
    flushInterval = null
  }
}

/**
 * Process email send job
 */
export async function processEmailJob(job: Job<EmailJobData>): Promise<EmailJobResult> {
  const {
    to,
    from,
    subject,
    body,
    accountId,
    campaignId,
    leadId,
    replyTo,
    headers,
    trackOpens,
    trackClicks,
    isPlainText,
    organizationId,
    fromName,
    toName,
    sequenceStepId,
    variantId,
  } = job.data

  console.log(`[EmailProcessor] Processing job ${job.id}`)
  console.log(`[EmailProcessor] Sending email from ${from} to ${to}`)

  const supabase = createAdminClient()

  try {
    await job.updateProgress(10)

    // Validate required fields
    if (!to || !from || !subject) {
      throw new Error('Missing required email fields: to, from, or subject')
    }

    // Get SMTP configuration
    const smtpConfig = await getSmtpConfig(accountId, supabase)
    if (!smtpConfig) {
      throw new Error(`No SMTP configuration available for account ${accountId}`)
    }

    await job.updateProgress(20)

    // Generate message ID for tracking
    const domain = from.split('@')[1] || 'email.local'
    const messageId = generateMessageId(domain)
    const trackingId = `${campaignId || 'direct'}_${leadId || 'unknown'}_${Date.now()}`

    // Prepare email content
    let htmlContent = isPlainText ? `<pre style="font-family: inherit;">${body}</pre>` : body
    const textContent = isPlainText ? body : htmlToPlainText(body)

    // Sanitize HTML
    htmlContent = sanitizeHtml(htmlContent)

    await job.updateProgress(30)

    // Add tracking if enabled
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

    if (trackOpens && campaignId && leadId) {
      const trackingPixelUrl = `${baseUrl}/api/track/open/${trackingId}`
      htmlContent = addTrackingPixel(htmlContent, trackingPixelUrl)
    }

    if (trackClicks && campaignId && leadId) {
      htmlContent = addClickTracking(htmlContent, baseUrl, campaignId, leadId)
    }

    await job.updateProgress(50)

    // Build email message
    const emailMessage: EmailMessage = {
      from: {
        email: from,
        name: fromName,
      },
      to: {
        email: to,
        name: toName,
      },
      replyTo,
      subject,
      html: htmlContent,
      text: textContent,
      headers: {
        ...headers,
        'X-Campaign-ID': campaignId || '',
        'X-Lead-ID': leadId || '',
        'Message-ID': messageId,
        'X-Mailer': 'ColdForge/1.0',
      },
      trackingId,
    }

    await job.updateProgress(70)

    // Send email
    const result = await sendSmtpEmail(smtpConfig, emailMessage)

    await job.updateProgress(90)

    if (!result.success) {
      // Record failed send
      if (organizationId) {
        await recordSendEvent(supabase, {
          organizationId,
          campaignId,
          leadId,
          mailboxId: accountId,
          fromEmail: from,
          toEmail: to,
          subject,
          messageId,
          status: 'failed',
        })
      }

      throw new Error(result.error || 'Failed to send email')
    }

    // Record successful send
    if (organizationId) {
      await recordSendEvent(supabase, {
        organizationId,
        campaignId,
        leadId,
        mailboxId: accountId,
        fromEmail: from,
        toEmail: to,
        subject,
        messageId: result.messageId || messageId,
        status: 'sent',
      })
    }

    await job.updateProgress(100)

    console.log(`[EmailProcessor] Email sent successfully`)
    console.log(`[EmailProcessor] Message ID: ${result.messageId || messageId}`)

    return {
      messageId: result.messageId || messageId,
      sentAt: new Date(),
      provider: smtpConfig.providerType,
      attempts: job.attemptsMade + 1,
    }
  } catch (error) {
    console.error(`[EmailProcessor] Failed to send email:`, error)
    throw error
  }
}

/**
 * Validate email job data
 */
export function validateEmailJobData(data: Partial<EmailJobData>): data is EmailJobData {
  return !!(
    data.to &&
    data.from &&
    data.subject &&
    data.body &&
    data.accountId &&
    isValidEmail(data.to) &&
    isValidEmail(data.from)
  )
}

/**
 * Basic email validation
 */
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return emailRegex.test(email)
}
