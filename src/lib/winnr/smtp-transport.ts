import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import nodemailer, { type Transport } from 'nodemailer'
import SMTPConnection from 'nodemailer/lib/smtp-connection'
import type { Readable } from 'node:stream'
import type Mail from 'nodemailer/lib/mailer'
import type SMTPTransport from 'nodemailer/lib/smtp-transport'
import { z } from 'zod'
import { smtpCredentialSchema, type WinnrSmtpCredential } from './smtp'

const cleanHeader = z.string().refine(value => !/[\r\n\0]/.test(value), 'Invalid SMTP header')
const messageId = cleanHeader.max(998).regex(/^<[^<>\s@]+@[^<>\s@]+>$/)
const reserved = new Set(['from','to','cc','bcc','sender','subject','message-id','in-reply-to','references','return-path','received','authentication-results','mime-version','content-type','content-transfer-encoding'])
export const smtpMessageSchema = z.object({
  from: z.email(), to: z.email(), subject: cleanHeader.max(998),
  text: z.string().max(1000000).optional(), html: z.string().max(1000000).optional(),
  messageId, inReplyTo: messageId.optional(), references: z.array(messageId).max(100).optional(),
  headers: z.record(z.string().regex(/^[A-Za-z0-9-]+$/), cleanHeader.max(4000)).optional(),
}).strict().refine(input => Boolean(input.text || input.html), 'Message content is required').refine(input => {
  const keys = Object.keys(input.headers ?? {}).map(key => key.toLowerCase())
  return new Set(keys).size === keys.length && keys.every(key => !reserved.has(key))
}, 'Reserved or duplicate SMTP headers')
export type WinnrSmtpMessage = z.infer<typeof smtpMessageSchema>
export function fingerprintWinnrSmtpMessage(raw: WinnrSmtpMessage): string {
  const message = smtpMessageSchema.parse(raw)
  return createHash('sha256').update(JSON.stringify({ from: message.from, to: message.to, subject: message.subject,
    text: message.text ?? null, html: message.html ?? null, messageId: message.messageId,
    inReplyTo: message.inReplyTo ?? null, references: message.references ?? [],
    headers: Object.entries(message.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]).toSorted((a, b) => String(a[0]).localeCompare(String(b[0]))),
  })).digest('hex')
}
export interface WinnrSmtpSendInput {
  organizationId: string; connectionId: string; connectionVersion: number; mailboxId: string; claimToken: string; message: WinnrSmtpMessage
}
/** The authorizer atomically moves one reserved immutable job to dispatching.
 * It must reject stale/expired/used claims and return this grant exactly once.
 * A process-local set is defense in depth, never a substitute for SQL fencing.
 */
export interface WinnrSmtpClaimGrant {
  organizationId: string; connectionId: string; connectionVersion: number; mailboxId: string; claimToken: string; fingerprint: string; attemptId: string
}
export type SmtpConnectionOptions = SMTPTransport.Options & { pool: false }
export interface SmtpReceipt { accepted: unknown[]; rejected: unknown[]; messageId?: string }
export interface WinnrSmtpTransportDeps {
  loadCredentials(input: { organizationId: string; connectionId: string; connectionVersion: number; mailboxId: string }): Promise<WinnrSmtpCredential | null>
  resolve?(host: string): Promise<{ address: string; family: number }[]>
  authorizeClaim(input: WinnrSmtpSendInput & { fingerprint: string }): Promise<WinnrSmtpClaimGrant | null>
  sendTimeoutMs?: number
  createTransport?(options: SmtpConnectionOptions): { sendMail(message: Mail.Options): Promise<SmtpReceipt>; close(): void }
}
export type WinnrSmtpSendResult =
  | { outcome: 'accepted'; messageId: string; recipient: string }
  | { outcome: 'rejected'; code: 'invalid_message' | 'sender_unavailable' | 'unsafe_host' | 'invalid_claim' | 'claim_already_used' | 'smtp_rejected' }
  | { outcome: 'unknown'; code: 'smtp_outcome_unknown' }
export function isPublicSmtpAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const parts = address.split('.').map(Number); const [a, b, c] = parts
    if (a === undefined || b === undefined || c === undefined) return false
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113))
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase()
    const parts = lower.split(':')
    const first = Number.parseInt(parts[0] ?? '0', 16)
    const second = Number.parseInt(parts[1] || '0', 16)
    // Global-unicast only; exclude documentation, transition tunnels and the
    // protocol-assignment /23. IPv4-mapped/local/link-local cannot pass here.
    return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 && !(first === 0x2001 && (second < 0x200 || second === 0xdb8)) && !(first === 0x3fff && second < 0x1000)
  }
  return false
}
/** Nodemailer's nonpooled SMTPTransport.close does not own its active connection.
 * Keep MIME compilation in Nodemailer, but own the one connection and guard
 * every asynchronous phase so cancelled connect/auth callbacks cannot send DATA.
 */
function createCancellableSmtpTransport(options: SmtpConnectionOptions, credential: WinnrSmtpCredential) {
  let closed = false
  let cancel: (() => void) | undefined
  const adapter: Transport<SmtpReceipt> = {
    name: 'WinnrSingleAttempt', version: '1',
    close() { closed = true; cancel?.() },
    send(mail, callback) {
      if (closed) { callback(new Error('SMTP attempt cancelled'), { accepted: [], rejected: [] }); return }
      const connection = new SMTPConnection(options)
      let stream: Readable | undefined
      let settled = false
      const finish = (error: Error | null, receipt: SmtpReceipt = { accepted: [], rejected: [] }) => {
        if (settled) return
        settled = true
        stream?.destroy()
        // close() gracefully ends connected sockets; on cancellation/error force
        // destruction so buffered writes cannot continue after the deadline.
        if (error) connection._socket?.destroy()
        connection.close()
        callback(error, receipt)
      }
      cancel = () => finish(new Error('SMTP attempt cancelled'))
      connection.once('error', error => finish(error))
      connection.once('end', () => finish(new Error('SMTP connection ended')))
      connection.connect(error => {
        if (settled || closed) return
        if (error) { finish(error); return }
        connection.login({ user: credential.smtpUsername, pass: credential.smtpPassword }, error => {
          if (settled || closed) return
          if (error) { finish(error); return }
          stream = mail.message.createReadStream()
          connection.send(mail.message.getEnvelope(), stream, (error, info) => {
            if (settled || closed) return
            finish(error, error ? undefined : { accepted: info.accepted, rejected: info.rejected, messageId: mail.message.messageId() })
          })
        })
      })
    },
  }
  return nodemailer.createTransport<SmtpReceipt>(adapter)
}
async function smtpDeadline<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('SMTP deadline exceeded')), milliseconds) })
  try { return await Promise.race([work, deadline]) } finally { clearTimeout(timer) }
}
function exactRecipient(value: unknown, recipient: string): boolean {
  return value === recipient || (typeof value === 'object' && value !== null && 'address' in value && value.address === recipient)
}
export function createWinnrSmtpTransport(deps: WinnrSmtpTransportDeps) {
  const used = new Set<string>()
  return {
    async send(untrusted: WinnrSmtpSendInput): Promise<WinnrSmtpSendResult> {
      const raw = { ...untrusted }
      const parsed = smtpMessageSchema.safeParse(raw.message)
      if (!parsed.success || !raw.claimToken || !raw.organizationId || !raw.connectionId || !raw.mailboxId || !Number.isInteger(raw.connectionVersion) || raw.connectionVersion < 1) return { outcome: 'rejected', code: 'invalid_message' }
      // Copy/parse message before awaiting authorization so caller mutations
      // cannot change approved content during DNS, lookup or provider handoff.
      const message = parsed.data
      Object.freeze(message.headers); Object.freeze(message.references); Object.freeze(message)
      const fingerprint = fingerprintWinnrSmtpMessage(message)
      const claimKey = `${raw.organizationId}:${raw.claimToken}`
      if (used.has(claimKey)) return { outcome: 'rejected', code: 'claim_already_used' }
      let credential: WinnrSmtpCredential
      try {
        const found = await deps.loadCredentials(raw)
        credential = smtpCredentialSchema.parse(found)
        if (credential.providerMailboxId !== raw.mailboxId || credential.fromEmail !== message.from) return { outcome: 'rejected', code: 'sender_unavailable' }
      } catch { return { outcome: 'rejected', code: 'sender_unavailable' } }
      let address: string
      try {
        const resolved = await (deps.resolve ?? (host => lookup(host, { all: true, verbatim: true })))(credential.smtpHost)
        if (!resolved.length || resolved.some(item => !isPublicSmtpAddress(item.address))) return { outcome: 'rejected', code: 'unsafe_host' }
        const first = resolved[0]
        if (!first) return { outcome: 'rejected', code: 'unsafe_host' }
        address = first.address
      } catch { return { outcome: 'rejected', code: 'unsafe_host' } }
      let grant: WinnrSmtpClaimGrant | null
      try { grant = await deps.authorizeClaim({ ...raw, message, fingerprint }) } catch { return { outcome: 'rejected', code: 'invalid_claim' } }
      if (!grant || grant.organizationId !== raw.organizationId || grant.connectionId !== raw.connectionId || grant.connectionVersion !== raw.connectionVersion || grant.mailboxId !== raw.mailboxId || grant.claimToken !== raw.claimToken || grant.fingerprint !== fingerprint || !grant.attemptId) return { outcome: 'rejected', code: 'invalid_claim' }
      // Authorization is durable and single-use; do not reauthorize/retry after
      // any SMTP handoff. Concurrent reuse in this process also fails closed.
      if (used.has(claimKey)) return { outcome: 'rejected', code: 'claim_already_used' }
      used.add(claimKey)
      let sender: ReturnType<NonNullable<WinnrSmtpTransportDeps['createTransport']>> | undefined
      try {
        const options: SmtpConnectionOptions = { host: address, port: 465, secure: true, pool: false,
          name: credential.domain, logger: false, debug: false,
          auth: { user: credential.smtpUsername, pass: credential.smtpPassword },
          tls: { servername: credential.smtpHost, rejectUnauthorized: true, minVersion: 'TLSv1.2' },
          connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
          disableFileAccess: true, disableUrlAccess: true,
        }
        sender = (deps.createTransport ?? (options => createCancellableSmtpTransport(options, credential)))(options)
        const receipt = await smtpDeadline(sender.sendMail({ from: message.from, to: message.to,
          envelope: { from: message.from, to: [message.to] }, subject: message.subject, text: message.text, html: message.html,
          messageId: message.messageId, inReplyTo: message.inReplyTo, references: message.references, headers: message.headers,
          disableFileAccess: true, disableUrlAccess: true,
        }), deps.sendTimeoutMs ?? 30000)
        if (receipt.messageId === message.messageId && receipt.accepted.length === 1 && exactRecipient(receipt.accepted[0], message.to) && receipt.rejected.length === 0) return { outcome: 'accepted', messageId: message.messageId, recipient: message.to }
        if (receipt.accepted.length === 0 && receipt.rejected.some(recipient => exactRecipient(recipient, message.to))) return { outcome: 'rejected', code: 'smtp_rejected' }
        return { outcome: 'unknown', code: 'smtp_outcome_unknown' }
      } catch (error) {
        const negative = z.object({ responseCode: z.number().int().min(400).max(599), command: z.string() }).safeParse(error)
        if (negative.success && /^(?:AUTH|MAIL FROM|RCPT TO|DATA)(?:\b|$)/i.test(negative.data.command)) return { outcome: 'rejected', code: 'smtp_rejected' }
        return { outcome: 'unknown', code: 'smtp_outcome_unknown' }
      } finally { try { sender?.close() } catch { /* Never let close change the observed delivery result. */ } }
    },
  }
}
