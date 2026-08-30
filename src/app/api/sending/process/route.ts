import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  isWithinScheduleWindow,
  isMailboxThrottled,
  prepareEmail,
  generateMessageId,
  type EmailJobStatus,
  type MailboxSendingState,
  DEFAULT_THROTTLE_CONFIG,
  DEFAULT_SCHEDULE_WINDOWS,
} from '@/lib/sending'
import { generateUniqueEmailContent } from '@/lib/campaigns'
import {
  sendingLimiter,
  applyRateLimit,
  addRateLimitHeaders,
} from '@/lib/rate-limit/middleware'
import { invalidateAnalyticsCache, invalidateDashboardCache } from '@/lib/cache/queries'
import { buildUnsubscribeUrl } from '@/lib/compliance/unsubscribe-token'

interface JobRecord {
  id: string
  organization_id: string
  campaign_id: string
  lead_id: string
  mailbox_id: string
  sequence_step_id: string
  variant_id: string
  status: EmailJobStatus
  priority: number
  scheduled_at: string
  attempts: number
  max_attempts: number
}

// POST /api/sending/process - Process pending email jobs (called by cron/worker)
export async function POST(request: NextRequest) {
  // Apply rate limiting for sending operations (1000/hour)
  const { limited, response, result } = applyRateLimit(request, sendingLimiter)
  if (limited) return response!

  try {
    // Verify internal API key for cron jobs
    const authHeader = request.headers.get('authorization')
    const apiKey = process.env.INTERNAL_API_KEY

    // Allow both internal key and authenticated users
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user && authHeader !== `Bearer ${apiKey}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()
    const { organizationId, campaignId, batchSize = 10 } = body

    // Get pending jobs
    let query = supabase
      .from('email_jobs')
      .select('*')
      .in('status', ['scheduled', 'pending'])
      .lte('scheduled_at', new Date().toISOString())
      .order('priority', { ascending: false })
      .order('scheduled_at', { ascending: true })
      .limit(batchSize)

    if (organizationId) {
      query = query.eq('organization_id', organizationId)
    }

    if (campaignId) {
      query = query.eq('campaign_id', campaignId)
    }

    const { data: jobs, error } = await query as {
      data: JobRecord[] | null
      error: Error | null
    }

    if (error) {
      console.error('Error fetching jobs:', error)
      return NextResponse.json({ error: 'Failed to fetch jobs' }, { status: 500 })
    }

    if (!jobs || jobs.length === 0) {
      return NextResponse.json({
        processed: 0,
        message: 'No pending jobs',
      })
    }

    const results = {
      processed: 0,
      sent: 0,
      failed: 0,
      rescheduled: 0,
      errors: [] as string[],
    }

    // Process each job
    for (const job of jobs) {
      try {
        // Mark as processing
        await supabase
          .from('email_jobs')
          .update({
            status: 'processing',
            attempts: job.attempts + 1,
            last_attempt_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', job.id)

        // Get campaign settings
        const { data: campaign } = await supabase
          .from('campaigns')
          .select('settings, status')
          .eq('id', job.campaign_id)
          .single() as {
            data: {
              settings: {
                timezone: string
                trackOpens: boolean
                trackClicks: boolean
                unsubscribeLink: boolean
              }
              status: string
            } | null
          }

        if (!campaign || campaign.status !== 'active') {
          // Cancel job if campaign is not active
          await supabase
            .from('email_jobs')
            .update({
              status: 'cancelled',
              error: 'Campaign not active',
              updated_at: new Date().toISOString(),
            })
            .eq('id', job.id)
          continue
        }

        // Check schedule window
        if (!isWithinScheduleWindow(DEFAULT_SCHEDULE_WINDOWS, campaign.settings.timezone)) {
          // Reschedule for next window
          await supabase
            .from('email_jobs')
            .update({
              status: 'scheduled',
              updated_at: new Date().toISOString(),
            })
            .eq('id', job.id)
          results.rescheduled++
          continue
        }

        // Get mailbox details
        const { data: mailbox } = await supabase
          .from('mailboxes')
          .select('email, first_name, last_name, smtp_credentials, emails_sent_today, daily_sending_limit')
          .eq('id', job.mailbox_id)
          .single() as {
            data: {
              email: string
              first_name: string
              last_name: string
              smtp_credentials: {
                host: string
                port: number
                username: string
                password: string
              } | null
              emails_sent_today: number
              daily_sending_limit: number
            } | null
          }

        if (!mailbox || !mailbox.smtp_credentials) {
          await supabase
            .from('email_jobs')
            .update({
              status: 'failed',
              error: 'Mailbox not configured',
              updated_at: new Date().toISOString(),
            })
            .eq('id', job.id)
          results.failed++
          continue
        }

        // Check throttling
        const mailboxState: MailboxSendingState = {
          mailboxId: job.mailbox_id,
          sentToday: mailbox.emails_sent_today,
          sentThisHour: 0, // Would need hourly tracking
          dailyLimit: mailbox.daily_sending_limit || DEFAULT_THROTTLE_CONFIG.maxPerDay,
          hourlyLimit: DEFAULT_THROTTLE_CONFIG.maxPerHour,
          isThrottled: false,
        }

        const throttleResult = isMailboxThrottled(mailboxState, DEFAULT_THROTTLE_CONFIG)
        if (throttleResult.throttled) {
          // Reschedule
          const rescheduleTime = new Date(Date.now() + (throttleResult.retryAfter || 3600) * 1000)
          await supabase
            .from('email_jobs')
            .update({
              status: 'scheduled',
              scheduled_at: rescheduleTime.toISOString(),
              error: throttleResult.reason,
              updated_at: new Date().toISOString(),
            })
            .eq('id', job.id)
          results.rescheduled++
          continue
        }

        // Get lead details
        const { data: lead } = await supabase
          .from('leads')
          .select('email, first_name, last_name, company, title, custom_fields')
          .eq('id', job.lead_id)
          .single() as {
            data: {
              email: string
              first_name: string | null
              last_name: string | null
              company: string | null
              title: string | null
              custom_fields: Record<string, string>
            } | null
          }

        if (!lead) {
          await supabase
            .from('email_jobs')
            .update({
              status: 'failed',
              error: 'Lead not found',
              updated_at: new Date().toISOString(),
            })
            .eq('id', job.id)
          results.failed++
          continue
        }

        // Get sequence step and variant
        const { data: sequence } = await supabase
          .from('campaign_sequences')
          .select('steps')
          .eq('campaign_id', job.campaign_id)
          .single() as {
            data: {
              steps: Array<{
                id: string
                variants: Array<{
                  id: string
                  subject: string
                  body: string
                }>
              }>
            } | null
          }

        const step = sequence?.steps.find(s => s.id === job.sequence_step_id)
        const variant = step?.variants.find(v => v.id === job.variant_id) || step?.variants[0]

        if (!variant) {
          await supabase
            .from('email_jobs')
            .update({
              status: 'failed',
              error: 'Variant not found',
              updated_at: new Date().toISOString(),
            })
            .eq('id', job.id)
          results.failed++
          continue
        }

        // Process template variables
        const leadData = {
          email: lead.email,
          firstName: lead.first_name || undefined,
          lastName: lead.last_name || undefined,
          company: lead.company || undefined,
          title: lead.title || undefined,
          customFields: lead.custom_fields,
        }

        const senderData = {
          name: `${mailbox.first_name} ${mailbox.last_name}`,
          email: mailbox.email,
        }

        // Generate unique email content with spintax variations
        // Uses deterministic seed from campaignId + lead.email for consistent variations per recipient
        const { subject, body } = generateUniqueEmailContent(
          variant.subject,
          variant.body,
          leadData,
          senderData,
          job.campaign_id
        )

        // Generate message ID
        const domain = mailbox.email.split('@')[1] ?? 'unknown'
        const messageId = generateMessageId(domain)

        // Prepare email content
        const trackingBaseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
        // Signed token, not raw ids. The previous shape
        // (`?lead=<uuid>&campaign=<uuid>`) was unauthenticated, so anyone
        // holding one email could forge opt-outs for other recipients.
        //
        // NOTE: this path carries `organization_id` while `email_suppressions`
        // references `workspaces(id)`. That is the dual-tenancy split recorded
        // in docs/PRODUCTION-PLAN.md item 4; the tenant id is passed through
        // verbatim here and must be remapped when tenancy consolidates.
        const unsubscribeUrl = buildUnsubscribeUrl(trackingBaseUrl, {
          leadId: job.lead_id,
          campaignId: job.campaign_id,
          workspaceId: job.organization_id,
        })

        // Prepare email content (currently unused - will be used for actual sending)
        void prepareEmail(
          {
            from: { email: mailbox.email, name: `${mailbox.first_name} ${mailbox.last_name}` },
            to: { email: lead.email, name: [lead.first_name, lead.last_name].filter(Boolean).join(' ') || undefined },
            subject,
            html: body,
            text: '',
          },
          {
            trackOpens: campaign.settings.trackOpens,
            trackClicks: campaign.settings.trackClicks,
            addUnsubscribe: campaign.settings.unsubscribeLink,
            trackingBaseUrl,
            unsubscribeUrl,
            campaignId: job.campaign_id,
            leadId: job.lead_id,
            messageId,
          }
        )

        // This path does not send. It previously hardcoded `sendSuccess = true`
        // and wrote status:'sent' with a generated message_id, so email_jobs
        // recorded deliveries that never happened — corrupting analytics and
        // reporting a working campaign engine that does not exist.
        //
        // Failing closed instead of faking success. Which implementation lands
        // here (native SMTP vs a vendor CampaignExecutionProvider) is the open
        // question in ADR-007, so no send is built here yet.
        const sendSuccess = false

        if (sendSuccess) {
          // Mark as sent
          await supabase
            .from('email_jobs')
            .update({
              status: 'sent',
              message_id: messageId,
              completed_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('id', job.id)

          // Update mailbox sent count
          await supabase
            .from('mailboxes')
            .update({
              emails_sent_today: mailbox.emails_sent_today + 1,
              updated_at: new Date().toISOString(),
            })
            .eq('id', job.mailbox_id)

          // Update lead status
          await supabase
            .from('leads')
            .update({
              status: 'contacted',
              last_contacted_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq('id', job.lead_id)

          // Update campaign stats
          await supabase.rpc('increment_campaign_stat', {
            p_campaign_id: job.campaign_id,
            p_stat: 'contacted',
          })

          results.sent++
        } else {
          // Handle failure
          if (job.attempts >= job.max_attempts) {
            await supabase
              .from('email_jobs')
              .update({
                status: 'failed',
                error: 'Max attempts reached',
                updated_at: new Date().toISOString(),
              })
              .eq('id', job.id)
            results.failed++
          } else {
            // Reschedule
            await supabase
              .from('email_jobs')
              .update({
                status: 'scheduled',
                scheduled_at: new Date(Date.now() + 300000).toISOString(), // 5 min
                updated_at: new Date().toISOString(),
              })
              .eq('id', job.id)
            results.rescheduled++
          }
        }

        results.processed++
      } catch (jobError) {
        console.error(`Error processing job ${job.id}:`, jobError)
        results.errors.push(`Job ${job.id}: ${jobError}`)

        // Mark as failed
        await supabase
          .from('email_jobs')
          .update({
            status: 'failed',
            error: jobError instanceof Error ? jobError.message : 'Unknown error',
            updated_at: new Date().toISOString(),
          })
          .eq('id', job.id)
        results.failed++
      }
    }

    // Invalidate analytics and dashboard cache if any emails were sent
    if (results.sent > 0) {
      // Find unique organization IDs from the processed jobs
      const orgIds = [...new Set(jobs?.map(j => j.organization_id) || [])]
      for (const orgId of orgIds) {
        invalidateAnalyticsCache(orgId)
        invalidateDashboardCache(orgId)
      }
    }

    const jsonResponse = NextResponse.json(results)
    return addRateLimitHeaders(jsonResponse, result)
  } catch (error) {
    console.error('Sending process error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
