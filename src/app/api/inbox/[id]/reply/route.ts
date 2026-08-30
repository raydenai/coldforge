import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { createTransporter, sendEmail, type EmailContent } from '@/lib/sending'
import { decryptObject } from '@/lib/encryption'
import { canReplyToInbound } from '@/lib/compliance/suppression'
import { google } from 'googleapis'
import { getGoogleOAuthClient, refreshGoogleToken } from '@/lib/google'
import { refreshMicrosoftToken } from '@/lib/microsoft'

// Types for email account
interface EmailAccountFull {
  id: string
  organization_id: string
  email: string
  display_name: string | null
  provider: 'google' | 'microsoft' | 'smtp'
  status: 'active' | 'paused' | 'error' | 'warming'
  smtp_host: string | null
  smtp_port: number | null
  smtp_username: string | null
  smtp_password_encrypted: string | null
  imap_host: string | null
  imap_port: number | null
  oauth_tokens_encrypted: string | null
}

interface OAuthTokens {
  access_token: string
  refresh_token: string
  expires_at?: number
}

interface SmtpCredentials {
  password: string
  imap?: {
    host: string
    port: number
    password: string
  }
}

interface ThreadData {
  id: string
  mailbox_id: string
  email_account_id: string | null
  subject: string
  participant_email: string
  participant_name: string | null
}

// Send email via Gmail API with proper reply headers
async function sendViaGmail(
  tokens: OAuthTokens,
  to: string,
  toName: string | null,
  from: string,
  fromName: string,
  subject: string,
  htmlBody: string,
  textBody: string,
  inReplyTo?: string,
  references?: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const oauth2Client = getGoogleOAuthClient()

    // Check if token needs refresh
    let accessToken = tokens.access_token
    if (tokens.expires_at && Date.now() >= tokens.expires_at) {
      const newTokens = await refreshGoogleToken(tokens.refresh_token)
      accessToken = newTokens.access_token || tokens.access_token
    }

    oauth2Client.setCredentials({
      access_token: accessToken,
      refresh_token: tokens.refresh_token,
    })

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client })

    // Build email headers
    const toHeader = toName ? `"${toName}" <${to}>` : to
    const fromHeader = `"${fromName}" <${from}>`
    const boundary = `boundary_${Date.now()}_${Math.random().toString(36).slice(2)}`

    const headers = [
      `From: ${fromHeader}`,
      `To: ${toHeader}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ]

    // Add threading headers if replying
    if (inReplyTo) {
      headers.push(`In-Reply-To: ${inReplyTo}`)
    }
    if (references) {
      headers.push(`References: ${references}`)
    }

    // Build multipart email
    const email = [
      ...headers,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 7bit',
      '',
      textBody,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: 7bit',
      '',
      htmlBody,
      '',
      `--${boundary}--`,
    ].join('\r\n')

    const encodedMessage = Buffer.from(email)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

    const response = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage,
        threadId: undefined, // Let Gmail auto-thread based on headers
      },
    })

    return {
      success: true,
      messageId: response.data.id || undefined,
    }
  } catch (error) {
    console.error('Gmail send error:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to send via Gmail',
    }
  }
}

// Send email via Microsoft Graph API with proper reply headers
async function sendViaMicrosoft(
  tokens: OAuthTokens,
  to: string,
  toName: string | null,
  from: string,
  fromName: string,
  subject: string,
  htmlBody: string,
  inReplyTo?: string,
  references?: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    // Check if token needs refresh
    let accessToken = tokens.access_token
    if (tokens.expires_at && Date.now() >= tokens.expires_at) {
      const newTokens = await refreshMicrosoftToken(tokens.refresh_token)
      accessToken = newTokens.accessToken || tokens.access_token
    }

    // Build internet message headers for threading
    const internetMessageHeaders: Array<{ name: string; value: string }> = []
    if (inReplyTo) {
      internetMessageHeaders.push({ name: 'In-Reply-To', value: inReplyTo })
    }
    if (references) {
      internetMessageHeaders.push({ name: 'References', value: references })
    }

    const messagePayload: Record<string, unknown> = {
      message: {
        subject,
        body: {
          contentType: 'HTML',
          content: htmlBody,
        },
        from: {
          emailAddress: {
            address: from,
            name: fromName,
          },
        },
        toRecipients: [
          {
            emailAddress: {
              address: to,
              name: toName || undefined,
            },
          },
        ],
        ...(internetMessageHeaders.length > 0 && { internetMessageHeaders }),
      },
    }

    const response = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(messagePayload),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Microsoft Graph API error: ${response.status} - ${errorText}`)
    }

    return {
      success: true,
      // Microsoft sendMail doesn't return a message ID, generate one for tracking
      messageId: `ms_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    }
  } catch (error) {
    console.error('Microsoft send error:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to send via Microsoft',
    }
  }
}

// Send email via SMTP
async function sendViaSmtp(
  smtpConfig: {
    host: string
    port: number
    user: string
    password: string
  },
  emailContent: EmailContent
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  try {
    const transporter = createTransporter({
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure: smtpConfig.port === 465,
      auth: {
        user: smtpConfig.user,
        pass: smtpConfig.password,
      },
    })

    const result = await sendEmail(transporter, emailContent)
    return {
      success: result.success,
      messageId: result.messageId,
      error: result.error,
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to send via SMTP',
    }
  }
}

// POST /api/inbox/[id]/reply - Send a reply to a thread
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: threadId } = await params
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Get user's organization from profiles or users table
    let organizationId: string | null = null

    const { data: profile } = await supabase
      .from('profiles')
      .select('organization_id')
      .eq('id', user.id)
      .single() as { data: { organization_id: string } | null }

    if (profile?.organization_id) {
      organizationId = profile.organization_id
    } else {
      // Fallback to users table
      const { data: userRecord } = await supabase
        .from('users')
        .select('organization_id')
        .eq('id', user.id)
        .single() as { data: { organization_id: string } | null }

      organizationId = userRecord?.organization_id || null
    }

    if (!organizationId) {
      return NextResponse.json({ error: 'Organization not found' }, { status: 404 })
    }

    // Get the thread
    const { data: thread } = await supabase
      .from('threads')
      .select('id, mailbox_id, email_account_id, subject, participant_email, participant_name')
      .eq('id', threadId)
      .eq('organization_id', organizationId)
      .single() as { data: ThreadData | null }

    if (!thread) {
      return NextResponse.json({ error: 'Thread not found' }, { status: 404 })
    }

    const body = await request.json()
    const { message, fromAccountId } = body

    if (!message) {
      return NextResponse.json({ error: 'Message is required' }, { status: 400 })
    }

    // Determine which email account to use
    // Priority: fromAccountId param > thread.email_account_id > thread.mailbox_id (legacy)
    const accountId = fromAccountId || thread.email_account_id

    if (!accountId) {
      return NextResponse.json({
        error: 'No email account specified. Please provide fromAccountId or ensure thread has an email_account_id'
      }, { status: 400 })
    }

    // Get the email account with credentials
    const { data: emailAccount, error: accountError } = await supabase
      .from('email_accounts')
      .select('*')
      .eq('id', accountId)
      .eq('organization_id', organizationId)
      .single() as { data: EmailAccountFull | null; error: unknown }

    if (accountError || !emailAccount) {
      return NextResponse.json({ error: 'Email account not found' }, { status: 404 })
    }

    if (emailAccount.status !== 'active') {
      return NextResponse.json({
        error: `Email account is not active (status: ${emailAccount.status})`
      }, { status: 400 })
    }

    // Get the latest message in thread for In-Reply-To header
    const { data: latestMessage } = await supabase
      .from('replies')
      .select('message_id')
      .eq('thread_id', threadId)
      .order('received_at', { ascending: false })
      .limit(1)
      .single() as { data: { message_id: string } | null }

    // Also check thread_messages for the latest message
    const { data: latestThreadMessage } = await supabase
      .from('thread_messages')
      .select('message_id')
      .eq('thread_id', threadId)
      .order('sent_at', { ascending: false })
      .limit(1)
      .single() as { data: { message_id: string } | null }

    // Use the most recent message ID for threading
    const replyToMessageId = latestMessage?.message_id || latestThreadMessage?.message_id

    // Prepare subject (add Re: if not present)
    const subject = thread.subject.match(/^re:/i)
      ? thread.subject
      : `Re: ${thread.subject}`

    // Generate message ID for tracking
    const emailDomain = emailAccount.email.split('@')[1] ?? 'instantscale.com'
    const generatedMessageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@${emailDomain}>`

    // Get display name
    const fromName = emailAccount.display_name || emailAccount.email.split('@')[0] || 'Unknown'

    // Plain text version
    const textBody = message.replace(/<[^>]*>/g, '')

    // Suppression gate, placed before the provider switch so it covers the
    // Gmail, Outlook and SMTP branches alike. This path previously called
    // sendEmail() with no suppression check at all.
    //
    // Narrower than the campaign gate by design: an unsubscribe does not bar
    // replying to someone who wrote to us, but a complaint or spam trap does.
    if (organizationId) {
      const replyEligibility = await canReplyToInbound(
        thread.participant_email,
        organizationId
      )

      if (!replyEligibility.eligible) {
        return NextResponse.json(
          { error: 'Cannot send to this recipient', reason: replyEligibility.reason },
          { status: 409 }
        )
      }
    }

    // Send email based on provider
    let sendResult: { success: boolean; messageId?: string; error?: string }

    switch (emailAccount.provider) {
      case 'google': {
        if (!emailAccount.oauth_tokens_encrypted) {
          return NextResponse.json({ error: 'No OAuth tokens configured for this account' }, { status: 400 })
        }

        const tokens = decryptObject<OAuthTokens>(
          typeof emailAccount.oauth_tokens_encrypted === 'string'
            ? emailAccount.oauth_tokens_encrypted
            : JSON.stringify(emailAccount.oauth_tokens_encrypted)
        )

        sendResult = await sendViaGmail(
          tokens,
          thread.participant_email,
          thread.participant_name,
          emailAccount.email,
          fromName,
          subject,
          message,
          textBody,
          replyToMessageId,
          replyToMessageId // Use same for References header
        )
        break
      }

      case 'microsoft': {
        if (!emailAccount.oauth_tokens_encrypted) {
          return NextResponse.json({ error: 'No OAuth tokens configured for this account' }, { status: 400 })
        }

        const tokens = decryptObject<OAuthTokens>(
          typeof emailAccount.oauth_tokens_encrypted === 'string'
            ? emailAccount.oauth_tokens_encrypted
            : JSON.stringify(emailAccount.oauth_tokens_encrypted)
        )

        sendResult = await sendViaMicrosoft(
          tokens,
          thread.participant_email,
          thread.participant_name,
          emailAccount.email,
          fromName,
          subject,
          message,
          replyToMessageId,
          replyToMessageId
        )
        break
      }

      case 'smtp': {
        if (!emailAccount.smtp_host || !emailAccount.smtp_password_encrypted) {
          return NextResponse.json({ error: 'SMTP not configured for this account' }, { status: 400 })
        }

        const credentials = decryptObject<SmtpCredentials>(emailAccount.smtp_password_encrypted)

        const emailContent: EmailContent = {
          from: {
            email: emailAccount.email,
            name: fromName,
          },
          to: {
            email: thread.participant_email,
            name: thread.participant_name || undefined,
          },
          subject,
          html: message,
          text: textBody,
          headers: {
            'Message-ID': generatedMessageId,
            ...(replyToMessageId && {
              'In-Reply-To': replyToMessageId,
              'References': replyToMessageId,
            }),
          },
        }

        sendResult = await sendViaSmtp(
          {
            host: emailAccount.smtp_host,
            port: emailAccount.smtp_port || 587,
            user: emailAccount.smtp_username || emailAccount.email,
            password: credentials.password,
          },
          emailContent
        )
        break
      }

      default:
        return NextResponse.json({ error: `Unsupported provider: ${emailAccount.provider}` }, { status: 400 })
    }

    if (!sendResult.success) {
      console.error('Failed to send reply:', sendResult.error)
      return NextResponse.json({
        error: sendResult.error || 'Failed to send email'
      }, { status: 500 })
    }

    // Use the generated message ID for tracking (or the one returned by provider)
    const finalMessageId = sendResult.messageId?.startsWith('<')
      ? sendResult.messageId
      : generatedMessageId

    const sentAt = new Date().toISOString()

    // Use admin client for inserts to bypass RLS
    const adminClient = createAdminClient()

    // Record the outbound message in thread_messages
    await adminClient.from('thread_messages')
      .insert({
        thread_id: threadId,
        direction: 'outbound',
        message_id: finalMessageId,
        from_email: emailAccount.email,
        from_name: fromName,
        to_email: thread.participant_email,
        subject,
        body_text: textBody,
        body_html: message,
        sent_at: sentAt,
      })

    // Also record in replies table with direction='outbound' for unified tracking
    await adminClient.from('replies')
      .insert({
        organization_id: organizationId,
        thread_id: threadId,
        email_account_id: accountId,
        message_id: finalMessageId,
        from_email: emailAccount.email,
        from_name: fromName,
        to_email: thread.participant_email,
        subject,
        body_text: textBody,
        body_html: message,
        direction: 'outbound',
        status: 'sent',
        received_at: sentAt,
      })

    // Update thread last_message_at
    await supabase.from('threads')
      .update({
        last_message_at: sentAt,
        updated_at: sentAt,
      })
      .eq('id', threadId)

    // Increment thread message count
    await supabase.rpc('increment_thread_message_count', {
      p_thread_id: threadId,
    })

    // Mark inbound replies as replied
    await supabase.from('replies')
      .update({ status: 'replied', updated_at: sentAt })
      .eq('thread_id', threadId)
      .eq('status', 'read')
      .neq('direction', 'outbound')

    return NextResponse.json({
      success: true,
      messageId: finalMessageId,
      sentAt,
      provider: emailAccount.provider,
      fromEmail: emailAccount.email,
    })
  } catch (error) {
    console.error('Send reply error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
