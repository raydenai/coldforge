import { parse } from 'csv-parse/sync'
import { z } from 'zod'
import { encrypt } from '@/lib/encryption'
import { WinnrApiError, type WinnrAuthContext } from './server'
import { WinnrClient } from './client'
import { createServiceRoleRepository } from './database'
import { createWinnrSmtpRepository } from './smtp-database'

const headerSafe = z.string().refine(value => !/[\r\n\0]/.test(value))
const host = headerSafe.min(1).max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i)
export const smtpCredentialSchema = z.object({
  providerMailboxId: z.string().min(1).max(200), domain: host, fromEmail: z.email(), fromName: headerSafe.max(200),
  smtpHost: host, smtpPort: z.literal(465), smtpUsername: z.email(), smtpPassword: z.string().min(1).max(4096),
  imapHost: host, imapPort: z.literal(993), imapUsername: z.email(), imapPassword: z.string().min(1).max(4096), footer: z.string().max(10000),
}).strict().refine(secret => secret.smtpUsername === secret.fromEmail && secret.imapUsername === secret.fromEmail, 'Mailbox usernames must match the sender address')
export type WinnrSmtpCredential = z.infer<typeof smtpCredentialSchema>
export const smtpImportInput = z.object({ expectedConnectionId: z.string().uuid(), expectedConnectionVersion: z.number().int().positive(), mailboxIds: z.array(z.string().min(1).max(200)).min(1).max(100) }).strict().refine(input => new Set(input.mailboxIds).size === input.mailboxIds.length, 'Duplicate mailbox selections')
export const smtpStatusSchema = z.object({ providerMailboxId: z.string(), email: z.string(), accountId: z.string(), syncedAt: z.string() })
export type WinnrSmtpStatus = z.infer<typeof smtpStatusSchema>
export interface EncryptedSmtpMailbox { providerMailboxId: string; email: string; displayName: string; ciphertext: string }
export interface SmtpPersistInput { actorId: string; organizationId: string; connectionId: string; connectionVersion: number; mailboxes: EncryptedSmtpMailbox[] }
export interface SmtpSyncDeps {
  getConnection(org: string): Promise<{ connection: { id: string; version: number; permissions: string[] }; token: string } | null>
  listMailboxes(token: string, params: { cursor?: string; limit: number }): Promise<{ items: { id: string; email: string }[]; nextCursor: string | null; hasMore: boolean }>
  fetch: typeof fetch
  persist(input: SmtpPersistInput): Promise<WinnrSmtpStatus[]>
  encrypt?(secret: string): string
  timeoutMs?: number
}
function refusal(message: string, status = 502): never { throw new WinnrApiError(status, status === 403 ? 'forbidden' : 'provider_error', message) }
const columns = ['domain', 'from_email', 'from_name', 'user_name', 'password', 'smtp_host', 'smtp_port', 'imap_host', 'imap_port', 'imap_username', 'imap_password', 'footer']
export function parseWinnrSmtpCsv(csv: string, selected: { id: string; email: string }[]): WinnrSmtpCredential[] {
  try {
    if (Buffer.byteLength(csv, 'utf8') > 5 * 1024 * 1024 || selected.length === 0) throw new Error()
    const raw: unknown = parse(csv, { bom: true, relax_column_count: false, skip_empty_lines: true, max_record_size: 100000 })
    const rows = z.array(z.array(z.string())).max(10001).parse(raw)
    const headers = rows.shift()
    if (!headers || headers.length !== columns.length || new Set(headers).size !== columns.length || columns.some(name => !headers.includes(name))) throw new Error()
    const expected = new Map(selected.map(mailbox => [mailbox.email, mailbox.id]))
    if (expected.size !== selected.length) throw new Error()
    const domains = new Set(selected.map(mailbox => mailbox.email.split('@')[1]?.toLowerCase()))
    const seen = new Set<string>(); const results: WinnrSmtpCredential[] = []
    for (const values of rows) {
      const row = Object.fromEntries(headers.map((name, index) => [name, values[index]]))
      const domain = String(row.domain).toLowerCase(); const email = z.email().parse(row.from_email)
      if (!domains.has(domain) || email.split('@')[1]?.toLowerCase() !== domain || seen.has(email)) throw new Error()
      seen.add(email)
      // Validate all rows, including nonselected mailboxes on the exported domain.
      const secret = smtpCredentialSchema.parse({ providerMailboxId: expected.get(email) ?? 'not-selected', domain,
        fromEmail: email, fromName: row.from_name, smtpUsername: row.user_name, smtpPassword: row.password,
        smtpHost: row.smtp_host, smtpPort: Number(row.smtp_port), imapHost: row.imap_host, imapPort: Number(row.imap_port),
        imapUsername: row.imap_username, imapPassword: row.imap_password, footer: row.footer })
      if (secret.smtpUsername !== email || secret.imapUsername !== email) throw new Error()
      if (expected.has(email)) results.push(secret)
    }
    if (results.length !== selected.length) throw new Error()
    return results
  } catch { return refusal('Winnr credential CSV is invalid or incomplete') }
}
export function validateS3DownloadUrl(raw: string): URL {
  try {
    const url = new URL(raw)
    // Exact AWS S3 host suffix, no custom origins, credentials, fragments or ports.
    const approved = /^(?:[a-z0-9][a-z0-9.-]*\.)?s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname)
    if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || url.hash || !approved || !url.searchParams.has('X-Amz-Signature')) throw new Error()
    return url
  } catch { return refusal('Winnr credential download URL is not permitted') }
}
async function boundedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (response.redirected || !response.ok || !response.body) return refusal('Winnr credential download failed')
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > maxBytes) return refusal('Winnr credential download exceeded its limit')
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal)
      if (done) break
      total += value.byteLength
      if (total > maxBytes) { void reader.cancel().catch(() => {}); return refusal('Winnr credential download exceeded its limit') }
      chunks.push(value)
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } finally { try { reader.releaseLock() } catch { void reader.cancel().catch(() => {}) } }
}
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('Winnr SMTP request deadline exceeded')
  let abort: () => void = () => {}
  const deadline = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('Winnr SMTP request deadline exceeded'))
    signal.addEventListener('abort', abort, { once: true })
  })
  try { return await Promise.race([promise, deadline]) } finally { signal.removeEventListener('abort', abort) }
}
export async function syncWinnrSmtpCredentials(actor: WinnrAuthContext, rawInput: unknown, deps: SmtpSyncDeps): Promise<{ mailboxes: WinnrSmtpStatus[] }> {
  if (!['owner', 'admin'].includes(actor.role)) return refusal('Only owners and admins may import SMTP credentials', 403)
  const input = smtpImportInput.parse(rawInput)
  const found = await deps.getConnection(actor.organizationId)
  if (!found || found.connection.id !== input.expectedConnectionId || found.connection.version !== input.expectedConnectionVersion) return refusal('Winnr connection changed; reload before importing', 409)
  if (!found.connection.permissions.includes('read') || !found.connection.permissions.includes('write')) return refusal('Winnr read and write permissions are required', 403)
  const all = new Map<string, string>(); const emails = new Set<string>(); const cursors = new Set<string>(); let cursor: string | undefined
  try {
    for (let pages = 0; ; pages++) {
      if (pages >= 100) return refusal('Mailbox inventory could not be fully verified')
      const page = await deps.listMailboxes(found.token, { cursor, limit: 100 })
      for (const mailbox of page.items) {
        z.email().parse(mailbox.email)
        if (all.has(mailbox.id) || emails.has(mailbox.email)) return refusal('Mailbox inventory is ambiguous')
        all.set(mailbox.id, mailbox.email); emails.add(mailbox.email)
      }
      if (!page.hasMore && !page.nextCursor) break
      if (!page.nextCursor || cursors.has(page.nextCursor)) return refusal('Mailbox inventory could not be fully verified')
      cursor = page.nextCursor; cursors.add(cursor)
    }
  } catch { return refusal('Mailbox inventory could not be verified') }
  const selected = input.mailboxIds.map(id => ({ id, email: all.get(id) }))
  const verified = selected.map(mailbox => {
    if (!mailbox.email) return refusal('Selected mailboxes do not belong to the connected account', 400)
    return { id: mailbox.id, email: mailbox.email }
  })
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), deps.timeoutMs ?? 15000)
  try {
    // Exactly one export POST. Its free operation cannot send mail, and is not retried.
    let exportResponse: Response
    try { exportResponse = await abortable(deps.fetch('https://api.winnr.app/v1/export', { method: 'POST', redirect: 'manual', credentials: 'omit', headers: { Authorization: `Bearer ${found.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ format: 'default', domains: [...new Set(verified.map(mailbox => mailbox.email.split('@')[1]?.toLowerCase()))], get_all: false }), signal: abort.signal }), abort.signal) }
    catch { return refusal('Winnr credential export failed; no retry was attempted') }
    let wire: unknown
    try { wire = JSON.parse(await boundedBody(exportResponse, 65536, abort.signal)) } catch { return refusal('Winnr credential export response is invalid') }
    const exported = z.object({ data: z.object({ download_url: z.string().nullable(), format: z.literal('default'), count: z.number().int().nonnegative(), expires_in: z.number().int().positive().max(900) }) }).safeParse(wire)
    if (!exported.success || !exported.data.data.download_url || exported.data.data.count < verified.length) return refusal('Winnr credential export is incomplete')
    const url = validateS3DownloadUrl(exported.data.data.download_url)
    let csv: string
    try {
      const download = await abortable(deps.fetch(url, { method: 'GET', redirect: 'manual', credentials: 'omit', signal: abort.signal }), abort.signal)
      csv = await boundedBody(download, 5 * 1024 * 1024, abort.signal)
    } catch { return refusal('Winnr credential download failed') }
    const credentials = parseWinnrSmtpCsv(csv, verified)
    const encrypted = credentials.map(secret => ({ providerMailboxId: secret.providerMailboxId, email: secret.fromEmail, displayName: secret.fromName, ciphertext: (deps.encrypt ?? encrypt)(JSON.stringify(secret)) }))
    const status = await deps.persist({ actorId: actor.userId, organizationId: actor.organizationId, connectionId: input.expectedConnectionId, connectionVersion: input.expectedConnectionVersion, mailboxes: encrypted })
    return { mailboxes: z.array(smtpStatusSchema).parse(status) }
  } catch (error) {
    if (error instanceof WinnrApiError) throw error
    return refusal('SMTP credential sync failed; no secrets were returned')
  } finally { clearTimeout(timer) }
}
export function createWinnrSmtpSyncDeps(): SmtpSyncDeps {
  const connectionRepo = createServiceRoleRepository(); const repo = createWinnrSmtpRepository()
  return { getConnection: org => connectionRepo.getConnectionWithToken(org), listMailboxes: (token, params) => WinnrClient({ token }).listMailboxes(params), fetch: globalThis.fetch, persist: input => repo.persist(input) }
}
