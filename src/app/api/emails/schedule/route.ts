import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { scheduleEmail, scheduleMultiple, getNextSendWindow, ScheduledEmail } from '@/lib/sending/scheduler'
import { AuthenticationError, BadRequestError, ValidationError } from '@/lib/errors'
import { handleApiError } from '@/lib/errors/handler'
import { isValidTimeZone } from '@/lib/compliance/sending-window'
import { z } from 'zod'

// Schema for single email scheduling
const scheduleEmailSchema = z.object({
  to: z.string().email('Invalid recipient email'),
  from: z.string().email('Invalid sender email'),
  subject: z.string().min(1, 'Subject is required'),
  body: z.string().min(1, 'Body is required'),
  scheduledAt: z.string().datetime('Invalid datetime format'),
  timezone: z.string().min(1, 'Timezone is required'),
  campaignId: z.string().optional(),
  leadId: z.string().optional(),
})

// Schema for batch email scheduling
const scheduleBatchSchema = z.object({
  emails: z.array(scheduleEmailSchema).min(1, 'At least one email is required'),
  spreadMinutes: z.number().min(1).max(1440).optional().default(60),
})

// POST /api/emails/schedule - Schedule a single email or batch of emails
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient()

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      throw new AuthenticationError()
    }

    // Get user's organization
    const { data: profile } = await supabase
      .from('users')
      .select('organization_id')
      .eq('id', user.id)
      .single() as { data: { organization_id: string } | null }

    if (!profile?.organization_id) {
      throw new BadRequestError('No organization found')
    }

    const body = await request.json()

    // Check if it's a batch request
    if (body.emails && Array.isArray(body.emails)) {
      // Batch scheduling
      const validationResult = scheduleBatchSchema.safeParse(body)
      if (!validationResult.success) {
        throw new ValidationError(
          validationResult.error.issues[0]?.message || 'Invalid request body',
          { issues: validationResult.error.issues }
        )
      }

      const { emails, spreadMinutes } = validationResult.data
      const scheduledEmails: ScheduledEmail[] = emails.map(email => ({
        ...email,
        scheduledAt: new Date(email.scheduledAt),
      }))

      const jobIds = await scheduleMultiple(scheduledEmails, spreadMinutes)

      return NextResponse.json({
        success: true,
        scheduled: jobIds.length,
        jobIds,
      }, { status: 201 })
    } else {
      // Single email scheduling
      const validationResult = scheduleEmailSchema.safeParse(body)
      if (!validationResult.success) {
        throw new ValidationError(
          validationResult.error.issues[0]?.message || 'Invalid request body',
          { issues: validationResult.error.issues }
        )
      }

      const emailData = validationResult.data
      const scheduledEmail: ScheduledEmail = {
        ...emailData,
        scheduledAt: new Date(emailData.scheduledAt),
      }

      const jobId = await scheduleEmail(scheduledEmail)

      return NextResponse.json({
        success: true,
        jobId,
      }, { status: 201 })
    }
  } catch (error) {
    return handleApiError(error)
  }
}

// GET /api/emails/schedule/next-window - Get next available send window
export async function GET(request: NextRequest) {
  try {
    const supabase = await createClient()

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      throw new AuthenticationError()
    }

    const { searchParams } = new URL(request.url)
    const timezone = searchParams.get('timezone') || 'UTC'
    const startHour = parseInt(searchParams.get('startHour') || '9', 10)
    const endHour = parseInt(searchParams.get('endHour') || '17', 10)

    // getNextSendWindow now rejects an unknown timezone instead of silently
    // falling back to server-local time. Surface that as a 400 rather than a 500,
    // since it is caller input.
    if (!isValidTimeZone(timezone)) {
      throw new ValidationError('Unknown timezone', { timezone })
    }

    if (
      !Number.isInteger(startHour) ||
      !Number.isInteger(endHour) ||
      startHour < 0 ||
      endHour > 24 ||
      startHour >= endHour
    ) {
      throw new ValidationError('Invalid send window hours', { startHour, endHour })
    }

    const nextWindow = getNextSendWindow(timezone, { start: startHour, end: endHour })

    return NextResponse.json({
      nextWindow: nextWindow.toISOString(),
      timezone,
      preferredHours: { start: startHour, end: endHour },
    })
  } catch (error) {
    return handleApiError(error)
  }
}
