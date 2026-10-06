import { decrypt } from '@/lib/encryption'
import { describe, expect, it, vi } from 'vitest'
import { parseWinnrSmtpCsv, syncWinnrSmtpCredentials, validateS3DownloadUrl, type SmtpSyncDeps } from '@/lib/winnr/smtp'
const columns = 'domain,from_email,from_name,user_name,password,smtp_host,smtp_port,imap_host,imap_port,imap_username,imap_password,footer'
const csv = `${columns}\nexample.test,sender@example.test,Sender,sender@example.test,synthetic-password,smtp.example.test,465,imap.example.test,993,sender@example.test,synthetic-imap,Regards\n`
const selected = [{ id: 'mailbox-1', email: 'sender@example.test' }]
const org = '11111111-1111-4111-8111-111111111111'
const conn = '22222222-2222-4222-8222-222222222222'
const actor = { userId: '33333333-3333-4333-8333-333333333333', organizationId: org, role: 'owner' as const }
const url = 'https://exports.s3.us-east-1.amazonaws.com/file.csv?X-Amz-Signature=private-signature'
function deps(download = csv) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => { void init; return String(input).startsWith('https://api.winnr.app/') ? Response.json({ data: { download_url: url, format: 'default', count: 1, expires_in: 900 } }) : new Response(download) })
  return { fetch, getConnection: vi.fn(async () => ({ connection: { id: conn, version: 3, permissions: ['read', 'write'] }, token: 'synthetic-token' })), listMailboxes: vi.fn<SmtpSyncDeps['listMailboxes']>(async () => ({ items: selected, nextCursor: null, hasMore: false })), encrypt: vi.fn(() => 'ciphertext'), persist: vi.fn<SmtpSyncDeps['persist']>(async () => [{ providerMailboxId: 'mailbox-1', email: 'sender@example.test', accountId: 'account-id', syncedAt: 'now' }]) }
}
const input = { expectedConnectionId: conn, expectedConnectionVersion: 3, mailboxIds: ['mailbox-1'] }
describe('Winnr private SMTP credential import', () => {
  it('parses documented rows and keeps secrets only in the private result', () => {
    const rows = parseWinnrSmtpCsv(csv, selected)
    expect(rows[0]?.smtpPassword).toBe('synthetic-password')
    expect(rows[0]?.smtpPort).toBe(465)
  })
  it('rejects duplicate, missing and wrong-domain rows without leaking raw CSV secrets', () => {
    for (const bad of [csv + csv.split('\n')[1] + '\n', `${columns}\n`, csv.replace('example.test,sender', 'foreign.test,sender')]) {
      try { parseWinnrSmtpCsv(bad, selected); throw new Error('Expected rejection') } catch (error) {
        expect(String(error)).not.toContain('synthetic-password')
        expect(String(error)).not.toContain('synthetic-imap')
        expect(String(error)).not.toContain('Expected rejection')
      }
    }
  })
  it('rejects non-S3 URLs, private hosts, credentials, wrong ports and redirects', async () => {
    for (const bad of ['http://exports.s3.amazonaws.com/x', 'https://127.0.0.1/x', 'https://exports.s3.amazonaws.com.evil.test/x', 'https://user:pass@exports.s3.amazonaws.com/x', 'https://exports.s3.amazonaws.com:8443/x']) expect(() => validateS3DownloadUrl(bad)).toThrow()
    const d = deps(); d.fetch.mockImplementation(async input => String(input).includes('/v1/export') ? Response.json({ data: { download_url: url, format: 'default', count: 1, expires_in: 900 } }) : new Response('', { status: 302, headers: { location: 'https://evil.test' } }))
    await expect(syncWinnrSmtpCredentials(actor, input, d)).rejects.toThrow('download')
    expect(d.persist).not.toHaveBeenCalled()
  })
  it('exports once and downloads with a separate request without Authorization', async () => {
    const d = deps(); const result = await syncWinnrSmtpCredentials(actor, input, d)
    expect(d.fetch).toHaveBeenCalledTimes(2)
    const exportInit = d.fetch.mock.calls[0]?.[1]
    const downloadInit = d.fetch.mock.calls[1]?.[1]
    expect(exportInit?.headers).toMatchObject({ Authorization: 'Bearer synthetic-token' })
    expect(JSON.parse(String(exportInit?.body))).toEqual({ format: 'default', domains: ['example.test'], get_all: false })
    expect(downloadInit?.headers).toBeUndefined()
    expect(downloadInit?.redirect).toBe('manual')
    expect(JSON.stringify(result)).not.toContain('synthetic-password')
    expect(JSON.stringify(result)).not.toContain('private-signature')
  })
  it('rejects members, stale connections and unowned selections before exporting', async () => {
    for (const [context, body] of [[{ ...actor, role: 'member' as const }, input], [actor, { ...input, expectedConnectionVersion: 2 }], [actor, { ...input, mailboxIds: ['foreign'] }]] as const) {
      const d = deps(); await expect(syncWinnrSmtpCredentials(context, body, d)).rejects.toThrow()
      expect(d.fetch).not.toHaveBeenCalled(); expect(d.persist).not.toHaveBeenCalled()
    }
  })
  it('verifies complete inventory even after selected IDs appear on the first page', async () => {
    const d = deps()
    d.listMailboxes.mockResolvedValueOnce({ items: selected, nextCursor: 'second', hasMore: true }).mockResolvedValueOnce({ items: selected, nextCursor: null, hasMore: false })
    await expect(syncWinnrSmtpCredentials(actor, input, d)).rejects.toThrow('inventory')
    expect(d.fetch).not.toHaveBeenCalled()
  })
  it('uses real encryption and keeps unselected domain mailboxes out of storage', async () => {
    const extra = csv + 'example.test,unselected@example.test,Other,unselected@example.test,other-password,smtp.example.test,465,imap.example.test,993,unselected@example.test,other-imap,Footer\n'
    const d = deps(extra)
    await syncWinnrSmtpCredentials(actor, input, { ...d, encrypt: undefined })
    const persisted = d.persist.mock.calls[0]?.[0]
    expect(persisted?.mailboxes).toHaveLength(1)
    const ciphertext = persisted?.mailboxes[0]?.ciphertext
    expect(ciphertext).not.toContain('synthetic-password')
    expect(JSON.parse(decrypt(ciphertext ?? ''))).toMatchObject({ smtpPassword: 'synthetic-password', providerMailboxId: 'mailbox-1' })
  })
  it('bounds both a hung export and a stalled download stream', async () => {
    const hung = deps(); hung.fetch.mockImplementation(() => new Promise(() => {}))
    await expect(syncWinnrSmtpCredentials(actor, input, { ...hung, timeoutMs: 5 })).rejects.toThrow('export')
    expect(hung.fetch).toHaveBeenCalledTimes(1)
    const stalled = deps()
    stalled.fetch.mockImplementation(async address => String(address).includes('/v1/export') ? Response.json({ data: { download_url: url, format: 'default', count: 1, expires_in: 900 } }) : new Response(new ReadableStream({ start() {} })))
    await expect(syncWinnrSmtpCredentials(actor, input, { ...stalled, timeoutMs: 5 })).rejects.toThrow('download')
    expect(stalled.persist).not.toHaveBeenCalled()
  })
  it('never retries an export timeout and never persists malformed rows', async () => {
    const d = deps(); d.fetch.mockRejectedValue(new Error('private-provider-error synthetic-password'))
    await expect(syncWinnrSmtpCredentials(actor, input, d)).rejects.toThrow('export')
    expect(d.fetch).toHaveBeenCalledTimes(1)
    const bad = deps(csv.replace(',465,', ',587,'))
    await expect(syncWinnrSmtpCredentials(actor, input, bad)).rejects.toThrow()
    expect(bad.persist).not.toHaveBeenCalled()
  })
})
