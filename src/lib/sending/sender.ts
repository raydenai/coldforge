// Email Sender Module

import nodemailer from 'nodemailer'
import type { EmailContent } from './types'
import { sendWithRetry, classifySmtpError } from '@/lib/retry/smtp'
import { buildUnsubscribeHeaders } from '@/lib/compliance/unsubscribe-token'

interface SmtpConfig {
  host: string
  port: number
  secure: boolean
  auth: {
    user: string
    pass: string
  }
}

interface SendResult {
  success: boolean
  messageId?: string
  error?: string
  errorCategory?: string
  attempts?: number
  totalTime?: number
}

// Create SMTP transporter
export function createTransporter(config: SmtpConfig): nodemailer.Transporter {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth,
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
    rateDelta: 1000,
    rateLimit: 5,
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 60000,
  })
}

// Send email via SMTP with retry logic
export async function sendEmail(
  transporter: nodemailer.Transporter,
  content: EmailContent,
  options?: {
    maxRetries?: number
    onRetry?: (error: Error, attempt: number, delay: number) => void
  }
): Promise<SendResult> {
  const result = await sendWithRetry(
    async () => {
      return await transporter.sendMail({
        from: `"${content.from.name}" <${content.from.email}>`,
        to: content.to.name
          ? `"${content.to.name}" <${content.to.email}>`
          : content.to.email,
        subject: content.subject,
        text: content.text,
        html: content.html || undefined,
        replyTo: content.replyTo,
        headers: content.headers,
      })
    },
    {
      maxRetries: options?.maxRetries ?? 3,
      onRetry: options?.onRetry,
    }
  )

  if (result.success && result.data) {
    return {
      success: true,
      messageId: result.data.messageId,
      attempts: result.attempts,
      totalTime: result.totalTime,
    }
  }

  return {
    success: false,
    error: result.error,
    errorCategory: result.error
      ? classifySmtpError(new Error(result.error))
      : undefined,
    attempts: result.attempts,
    totalTime: result.totalTime,
  }
}

// Send email without retry (for testing or specific use cases)
export async function sendEmailNoRetry(
  transporter: nodemailer.Transporter,
  content: EmailContent
): Promise<SendResult> {
  try {
    const info = await transporter.sendMail({
      from: `"${content.from.name}" <${content.from.email}>`,
      to: content.to.name
        ? `"${content.to.name}" <${content.to.email}>`
        : content.to.email,
      subject: content.subject,
      text: content.text,
      html: content.html || undefined,
      replyTo: content.replyTo,
      headers: content.headers,
    })

    return {
      success: true,
      messageId: info.messageId,
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return {
      success: false,
      error: errorMessage,
    }
  }
}

// Add tracking pixel to HTML
export function addTrackingPixel(
  html: string,
  trackingUrl: string
): string {
  const pixel = `<img src="${trackingUrl}" width="1" height="1" style="display:none" alt="" />`

  // Insert before closing body tag if exists
  if (html.includes('</body>')) {
    return html.replace('</body>', `${pixel}</body>`)
  }

  // Otherwise append at the end
  return html + pixel
}

// Add click tracking to links
export function addClickTracking(
  html: string,
  trackingBaseUrl: string,
  campaignId: string,
  leadId: string
): string {
  // Match href attributes in anchor tags
  const linkRegex = /<a\s+([^>]*?)href=["']([^"']+)["']([^>]*?)>/gi

  return html.replace(linkRegex, (match, before, url, after) => {
    // Skip mailto and tel links
    if (url.startsWith('mailto:') || url.startsWith('tel:')) {
      return match
    }

    // Skip unsubscribe links (keep them direct)
    if (url.includes('unsubscribe')) {
      return match
    }

    // Encode original URL
    const encodedUrl = encodeURIComponent(url)
    const trackingUrl = `${trackingBaseUrl}/track/click?url=${encodedUrl}&campaign=${campaignId}&lead=${leadId}`

    return `<a ${before}href="${trackingUrl}"${after}>`
  })
}

// Add unsubscribe link
export function addUnsubscribeLink(
  html: string,
  unsubscribeUrl: string
): string {
  const link = `
    <div style="text-align: center; margin-top: 20px; padding: 10px; font-size: 12px; color: #666;">
      <a href="${unsubscribeUrl}" style="color: #666; text-decoration: underline;">Unsubscribe</a>
    </div>
  `

  // Insert before closing body tag if exists
  if (html.includes('</body>')) {
    return html.replace('</body>', `${link}</body>`)
  }

  return html + link
}

// Generate plain text from HTML
export function htmlToPlainText(html: string): string {
  return html
    // Remove style and script tags with content
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    // Convert line breaks
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    // Convert links to text with URL
    .replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([^<]*)<\/a>/gi, '$2 ($1)')
    // Remove remaining HTML tags
    .replace(/<[^>]+>/g, '')
    // Decode HTML entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    // Clean up whitespace
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Validate email address
export function isValidEmailAddress(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return emailRegex.test(email)
}

// Sanitize HTML for email
export function sanitizeHtml(html: string): string {
  // Remove potentially dangerous elements
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<form[^>]*>[\s\S]*?<\/form>/gi, '')
    .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/javascript:/gi, '')
}

// Build email headers
export function buildHeaders(
  campaignId: string,
  leadId: string,
  messageId: string,
  options?: {
    /** Absolute one-click unsubscribe URL. See buildUnsubscribeUrl(). */
    unsubscribeUrl?: string
    /** Optional RFC-recommended mailto: fallback. */
    unsubscribeMailto?: string
  }
): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Campaign-ID': campaignId,
    'X-Lead-ID': leadId,
    'Message-ID': messageId,
    'X-Mailer': 'InstantScale/1.0',
  }

  // RFC 8058: List-Unsubscribe-Post is only meaningful alongside a
  // List-Unsubscribe target. Emitting the Post header alone — which this
  // function previously did — advertises one-click to Gmail and Yahoo while
  // giving them nothing to call, and counts against bulk-sender compliance.
  //
  // Both headers are emitted together or not at all.
  if (options?.unsubscribeUrl) {
    Object.assign(
      headers,
      buildUnsubscribeHeaders(options.unsubscribeUrl, options.unsubscribeMailto)
    )
  }

  return headers
}

// Prepare email for sending
export function prepareEmail(
  content: EmailContent,
  options: {
    trackOpens: boolean
    trackClicks: boolean
    addUnsubscribe: boolean
    trackingBaseUrl: string
    unsubscribeUrl: string
    campaignId: string
    leadId: string
    messageId: string
  }
): EmailContent {
  let html = content.html || ''
  let text = content.text

  // Sanitize HTML
  html = sanitizeHtml(html)

  // Add tracking
  if (options.trackOpens && html) {
    const trackingPixelUrl = `${options.trackingBaseUrl}/track/open?campaign=${options.campaignId}&lead=${options.leadId}&mid=${encodeURIComponent(options.messageId)}`
    html = addTrackingPixel(html, trackingPixelUrl)
  }

  if (options.trackClicks && html) {
    html = addClickTracking(html, options.trackingBaseUrl, options.campaignId, options.leadId)
  }

  // Add unsubscribe
  if (options.addUnsubscribe && html) {
    html = addUnsubscribeLink(html, options.unsubscribeUrl)
  }

  // Generate plain text if not provided
  if (!text && html) {
    text = htmlToPlainText(html)
  }

  // Build headers
  // Pass the unsubscribe URL through so List-Unsubscribe is emitted alongside
  // the body link. Without it the one-click headers are omitted entirely rather
  // than advertised-but-broken.
  const headers = buildHeaders(options.campaignId, options.leadId, options.messageId, {
    unsubscribeUrl: options.addUnsubscribe ? options.unsubscribeUrl : undefined,
  })

  return {
    ...content,
    html,
    text,
    headers: {
      ...content.headers,
      ...headers,
    },
  }
}
