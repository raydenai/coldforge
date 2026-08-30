import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createTransporter, sendEmail, type EmailContent } from '@/lib/sending'
import { canReplyToInbound } from '@/lib/compliance/suppression'

// POST /api/replies/[id]/respond - Send response to a reply
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Get user's organization
    const { data: profile } = await supabase
      .from('profiles')
      .select('organization_id')
      .eq('id', user.id)
      .single() as { data: { organization_id: string } | null }

    if (!profile) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 })
    }

    // Get the reply
    const { data: reply } = await supabase
      .from('replies')
      .select('*')
      .eq('id', id)
      .eq('organization_id', profile.organization_id)
      .single() as {
        data: {
          id: string
          thread_id: string
          message_id: string
          mailbox_id: string
          from_email: string
          from_name: string | null
          to_email: string
          subject: string
        } | null
      }

    if (!reply) {
      return NextResponse.json({ error: 'Reply not found' }, { status: 404 })
    }

    const body = await request.json()
    const { message, useMailbox } = body

    if (!message) {
      return NextResponse.json({ error: 'Message is required' }, { status: 400 })
    }

    // Get mailbox to send from
    const mailboxId = useMailbox || reply.mailbox_id
    const { data: mailbox } = await supabase
      .from('mailboxes')
      .select('id, email, smtp_host, smtp_port, smtp_user, smtp_pass, first_name, last_name')
      .eq('id', mailboxId)
      .eq('organization_id', profile.organization_id)
      .single() as {
        data: {
          id: string
          email: string
          smtp_host: string
          smtp_port: number
          smtp_user: string
          smtp_pass: string
          first_name: string | null
          last_name: string | null
        } | null
      }

    if (!mailbox) {
      return NextResponse.json({ error: 'Mailbox not found' }, { status: 404 })
    }

    // Prepare subject (add Re: if not present)
    const subject = reply.subject.match(/^re:/i)
      ? reply.subject
      : `Re: ${reply.subject}`

    // Generate message ID
    const emailDomain = mailbox.email.split('@')[1] ?? 'unknown'
    const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@${emailDomain}>`

    // Create email content
    const fromName = [mailbox.first_name, mailbox.last_name].filter(Boolean).join(' ') || mailbox.email.split('@')[0] || 'Unknown'
    const emailContent: EmailContent = {
      from: {
        email: mailbox.email,
        name: fromName,
      },
      to: {
        email: reply.from_email,
        name: reply.from_name || undefined,
      },
      subject,
      html: message,
      text: message.replace(/<[^>]*>/g, ''),
      headers: {
        'Message-ID': messageId,
        'In-Reply-To': reply.message_id,
        'References': reply.message_id,
      },
    }

    // Suppression gate. This path called sendEmail() directly with no check at
    // all. Narrower than the campaign gate: an unsubscribe does not bar
    // answering someone who wrote to us, but a complaint or spam trap does.
    // See canReplyToInbound() for the policy and its reasoning.
    const replyEligibility = await canReplyToInbound(
      reply.from_email,
      profile.organization_id
    )

    if (!replyEligibility.eligible) {
      return NextResponse.json(
        {
          error: 'Cannot send to this recipient',
          reason: replyEligibility.reason,
        },
        { status: 409 }
      )
    }

    // Send the email
    try {
      const transporter = createTransporter({
        host: mailbox.smtp_host,
        port: mailbox.smtp_port,
        secure: mailbox.smtp_port === 465,
        auth: {
          user: mailbox.smtp_user,
          pass: mailbox.smtp_pass,
        },
      })

      const result = await sendEmail(transporter, emailContent)

      if (!result.success) {
        throw new Error(result.error || 'Failed to send email')
      }
    } catch (sendError) {
      console.error('Failed to send response:', sendError)
      return NextResponse.json({ error: 'Failed to send email' }, { status: 500 })
    }

    // Record the outbound message in thread
    await supabase.from('thread_messages')
      .insert({
        thread_id: reply.thread_id,
        direction: 'outbound',
        message_id: messageId,
        from_email: mailbox.email,
        from_name: [mailbox.first_name, mailbox.last_name].filter(Boolean).join(' ') || null,
        to_email: reply.from_email,
        subject,
        body_text: message.replace(/<[^>]*>/g, ''),
        body_html: message,
        sent_at: new Date().toISOString(),
      })

    // Update reply status to replied
    await supabase.from('replies')
      .update({
        status: 'replied',
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)

    // Update thread
    await supabase.from('threads')
      .update({
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', reply.thread_id)

    // Increment thread message count
    await supabase.rpc('increment_thread_message_count', {
      p_thread_id: reply.thread_id,
    })

    return NextResponse.json({
      success: true,
      messageId,
    })
  } catch (error) {
    console.error('Send response error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
