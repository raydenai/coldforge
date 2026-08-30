/**
 * IMAP Sync Provider
 *
 * Fetches and syncs messages via IMAP for SMTP accounts.
 * Uses UID-based incremental sync for efficiency.
 */

import { ImapFlow, FetchMessageObject, MailboxObject } from 'imapflow'
import {
  SyncProvider,
  AccountCredentials,
  SyncState,
  SyncOptions,
  InboxMessage,
  EmailAddress,
  AttachmentInfo,
  ImapBodyStructure,
} from '../types'

export class ImapSyncProvider implements SyncProvider {
  readonly providerName = 'smtp' as const

  /**
   * Create IMAP client with credentials
   */
  private createClient(credentials: AccountCredentials): ImapFlow {
    if (
      !credentials.imapHost ||
      !credentials.imapPort ||
      !credentials.imapUser ||
      !credentials.imapPassword
    ) {
      throw new Error('IMAP credentials incomplete')
    }

    return new ImapFlow({
      host: credentials.imapHost,
      port: credentials.imapPort,
      secure: credentials.imapSecure !== false,
      auth: {
        user: credentials.imapUser,
        pass: credentials.imapPassword,
      },
      logger: false,
      tls: {
        rejectUnauthorized: false,
      },
    })
  }

  /**
   * Fetch messages from IMAP server
   */
  async fetchMessages(
    credentials: AccountCredentials,
    syncState: SyncState | null,
    options: SyncOptions
  ): Promise<{
    messages: InboxMessage[]
    newSyncState: Partial<SyncState>
    hasMore: boolean
  }> {
    const client = this.createClient(credentials)
    const messages: InboxMessage[] = []
    const batchSize = options.batchSize || 50
    let highestUid = syncState?.lastUid || 0
    let hasMore = false

    try {
      await client.connect()

      // Select INBOX
      const mailbox = await client.getMailboxLock('INBOX')

      try {
        const mailboxStatus = client.mailbox as MailboxObject | undefined

        // Build search criteria
        let searchCriteria: Record<string, unknown> = {}

        if (syncState?.lastUid && !options.fullSync) {
          // Incremental sync: messages with UID greater than last synced
          searchCriteria = { uid: `${syncState.lastUid + 1}:*` }
        } else if (options.since && !options.fullSync) {
          // Date-based sync
          searchCriteria = { since: options.since }
        } else {
          // Full sync - get all messages
          searchCriteria = { all: true }
        }

        // Fetch messages
        let count = 0
        const fetchOptions = {
          uid: true,
          flags: true,
          envelope: true,
          bodyStructure: true,
          source: true, // Get full message source
        }

        for await (const msg of client.fetch(
          searchCriteria,
          fetchOptions
        ) as AsyncIterable<FetchMessageObject>) {
          if (count >= batchSize) {
            hasMore = true
            break
          }

          try {
            const inboxMessage = await this.parseImapMessage(
              msg,
              credentials.accountId,
              credentials.organizationId || '',
              client
            )
            messages.push(inboxMessage)

            if (msg.uid > highestUid) {
              highestUid = msg.uid
            }
          } catch (parseError) {
            console.error(`Failed to parse IMAP message ${msg.uid}:`, parseError)
          }

          count++
        }

        return {
          messages,
          newSyncState: {
            lastUid: highestUid,
            lastSyncAt: new Date(),
            messagesTotal: mailboxStatus?.exists || 0,
            messagesSynced: (syncState?.messagesSynced || 0) + messages.length,
          },
          hasMore,
        }
      } finally {
        mailbox.release()
      }
    } finally {
      try {
        await client.logout()
      } catch {
        // Ignore logout errors
      }
    }
  }

  /**
   * Parse IMAP message to unified format
   */
  private async parseImapMessage(
    msg: FetchMessageObject,
    accountId: string,
    organizationId: string,
    _client: ImapFlow
  ): Promise<InboxMessage> {
    const envelope = msg.envelope

    // Parse sender
    const from: EmailAddress = envelope?.from?.[0]
      ? {
          email: envelope.from[0].address || 'unknown',
          name: envelope.from[0].name || null,
        }
      : { email: 'unknown', name: null }

    // Parse recipients
    const to = (envelope?.to || []).map((addr) => ({
      email: addr.address || 'unknown',
      name: addr.name || null,
    }))

    const cc = (envelope?.cc || []).map((addr) => ({
      email: addr.address || 'unknown',
      name: addr.name || null,
    }))

    const bcc = (envelope?.bcc || []).map((addr) => ({
      email: addr.address || 'unknown',
      name: addr.name || null,
    }))

    const replyTo = envelope?.replyTo?.[0]
      ? {
          email: envelope.replyTo[0].address || '',
          name: envelope.replyTo[0].name || null,
        }
      : null

    // Parse body from source
    const { textBody, htmlBody } = this.parseMessageSource(msg.source)

    // Parse attachments from body structure
    const attachments = this.extractAttachments(msg.bodyStructure)

    // Build headers from envelope
    const headers: Record<string, string> = {}
    if (envelope?.messageId) {
      headers['message-id'] = envelope.messageId
    }
    if (envelope?.inReplyTo) {
      headers['in-reply-to'] = envelope.inReplyTo
    }

    // Parse references
    const references: string[] = []
    if (envelope?.inReplyTo) {
      references.push(envelope.inReplyTo.replace(/[<>]/g, ''))
    }

    // Determine if message is read
    const flags = msg.flags || new Set()
    const isRead = flags.has('\\Seen')
    const isStarred = flags.has('\\Flagged')

    // Generate thread ID from subject and in-reply-to
    const normalizedSubject = this.normalizeSubject(envelope?.subject || '')
    const threadId = envelope?.inReplyTo
      ? envelope.inReplyTo.replace(/[<>]/g, '')
      : `thread_${Buffer.from(normalizedSubject).toString('base64').slice(0, 24)}`

    const date = envelope?.date || new Date()

    return {
      id: `imap_${accountId}_${msg.uid}`,
      externalId: String(msg.uid),
      threadExternalId: threadId,
      accountId,
      organizationId,
      provider: 'smtp',

      messageId: envelope?.messageId?.replace(/[<>]/g, '') || String(msg.uid),
      inReplyTo: envelope?.inReplyTo?.replace(/[<>]/g, '') || null,
      references,

      from,
      to,
      cc,
      bcc,
      replyTo,

      subject: envelope?.subject || '(no subject)',
      bodyText: textBody,
      bodyHtml: htmlBody,
      snippet: textBody.substring(0, 200),

      hasAttachments: attachments.length > 0,
      attachments,

      isRead,
      isStarred,
      labels: Array.from(flags).filter((f) => !f.startsWith('\\')),
      direction: 'inbound', // IMAP typically fetches inbound messages

      date,
      receivedAt: date,
      internalDate: date,

      rawHeaders: headers,
    }
  }

  /**
   * Parse message source to extract text and HTML body
   */
  private parseMessageSource(source?: Buffer): {
    textBody: string
    htmlBody: string | null
  } {
    if (!source) {
      return { textBody: '', htmlBody: null }
    }

    const rawMessage = source.toString('utf-8')
    let textBody = ''
    let htmlBody: string | null = null

    try {
      // Simple parsing - find boundary and extract parts
      const boundaryMatch = rawMessage.match(/boundary="?([^"\s]+)"?/i)

      if (boundaryMatch) {
        // Multipart message
        const boundary = boundaryMatch[1]
        const parts = rawMessage.split(`--${boundary}`)

        for (const part of parts) {
          if (part.includes('Content-Type: text/plain')) {
            const bodyStart = part.indexOf('\r\n\r\n')
            if (bodyStart !== -1) {
              textBody = this.decodeContent(
                part.substring(bodyStart + 4),
                this.getContentEncoding(part)
              )
            }
          } else if (part.includes('Content-Type: text/html')) {
            const bodyStart = part.indexOf('\r\n\r\n')
            if (bodyStart !== -1) {
              htmlBody = this.decodeContent(
                part.substring(bodyStart + 4),
                this.getContentEncoding(part)
              )
            }
          }
        }
      } else {
        // Simple message - body after headers
        const bodyStart = rawMessage.indexOf('\r\n\r\n')
        if (bodyStart !== -1) {
          const body = rawMessage.substring(bodyStart + 4)
          if (rawMessage.includes('Content-Type: text/html')) {
            htmlBody = this.decodeContent(body, this.getContentEncoding(rawMessage))
          } else {
            textBody = this.decodeContent(body, this.getContentEncoding(rawMessage))
          }
        }
      }

      // If we only have HTML, strip tags for text
      if (!textBody && htmlBody) {
        textBody = this.stripHtml(htmlBody)
      }
    } catch (error) {
      console.error('Failed to parse message source:', error)
      // Return raw text as fallback
      textBody = rawMessage.substring(0, 5000)
    }

    return { textBody, htmlBody }
  }

  /**
   * Get content transfer encoding from headers
   */
  private getContentEncoding(content: string): string {
    const match = content.match(/Content-Transfer-Encoding:\s*(\S+)/i)
    return match?.[1]?.toLowerCase() || '7bit'
  }

  /**
   * Decode content based on transfer encoding
   */
  private decodeContent(content: string, encoding: string): string {
    // Clean up the content first
    const cleanContent = content.replace(/--[\w-]+--?\s*$/g, '').trim()

    switch (encoding.toLowerCase()) {
      case 'base64':
        try {
          return Buffer.from(cleanContent.replace(/\s/g, ''), 'base64').toString(
            'utf-8'
          )
        } catch {
          return cleanContent
        }

      case 'quoted-printable':
        return cleanContent
          .replace(/=\r?\n/g, '') // Remove soft line breaks
          .replace(/=([0-9A-F]{2})/gi, (_, hex) =>
            String.fromCharCode(parseInt(hex, 16))
          )

      default:
        return cleanContent
    }
  }

  /**
   * Extract attachment info from body structure
   */
  private extractAttachments(bodyStructure?: ImapBodyStructure): AttachmentInfo[] {
    const attachments: AttachmentInfo[] = []

    const extractFromPart = (part: ImapBodyStructure, partId = '1') => {
      if (part.disposition === 'attachment' || part.dispositionParameters?.filename) {
        attachments.push({
          id: partId,
          filename:
            part.dispositionParameters?.filename ||
            part.parameters?.name ||
            'attachment',
          mimeType: `${part.type}/${part.subtype}`.toLowerCase(),
          size: part.size || 0,
        })
      }

      if (part.childNodes) {
        part.childNodes.forEach((child, index) => {
          extractFromPart(child, `${partId}.${index + 1}`)
        })
      }
    }

    if (bodyStructure) {
      extractFromPart(bodyStructure)
    }

    return attachments
  }

  /**
   * Normalize subject for thread grouping
   */
  private normalizeSubject(subject: string): string {
    return subject.replace(/^(re|fwd?|fw):\s*/gi, '').trim().toLowerCase()
  }

  /**
   * Strip HTML tags
   */
  private stripHtml(html: string): string {
    return html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  /**
   * Fetch a single message by UID
   */
  async fetchMessage(
    credentials: AccountCredentials,
    messageId: string
  ): Promise<InboxMessage | null> {
    const client = this.createClient(credentials)

    try {
      await client.connect()
      const mailbox = await client.getMailboxLock('INBOX')

      try {
        const uid = parseInt(messageId, 10)
        if (isNaN(uid)) {
          return null
        }

        const fetchOptions = {
          uid: true,
          flags: true,
          envelope: true,
          bodyStructure: true,
          source: true,
        }

        for await (const msg of client.fetch(
          { uid },
          fetchOptions
        ) as AsyncIterable<FetchMessageObject>) {
          return this.parseImapMessage(
            msg,
            credentials.accountId,
            credentials.organizationId || '',
            client
          )
        }

        return null
      } finally {
        mailbox.release()
      }
    } catch (error) {
      console.error(`Failed to fetch IMAP message ${messageId}:`, error)
      return null
    } finally {
      try {
        await client.logout()
      } catch {
        // Ignore logout errors
      }
    }
  }

  /**
   * Validate credentials by connecting to IMAP server
   */
  async validateCredentials(credentials: AccountCredentials): Promise<boolean> {
    const client = this.createClient(credentials)

    try {
      await client.connect()
      await client.logout()
      return true
    } catch {
      return false
    } finally {
      try {
        await client.logout()
      } catch {
        // Ignore
      }
    }
  }
}

// Export singleton instance
export const imapSyncProvider = new ImapSyncProvider()
