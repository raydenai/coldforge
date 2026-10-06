import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { encrypt } from '@/lib/encryption'
import { createWinnrSmtpRepository, type WinnrSmtpDatabase } from '@/lib/winnr/smtp-database'
const org = '11111111-1111-4111-8111-111111111111'; const conn = '22222222-2222-4222-8222-222222222222'
const secret = { providerMailboxId: 'mb-1', domain: 'example.test', fromEmail: 'sender@example.test', fromName: 'Sender', smtpHost: 'smtp.example.test', smtpPort: 465, smtpUsername: 'sender@example.test', smtpPassword: 'synthetic-private-password', imapHost: 'imap.example.test', imapPort: 993, imapUsername: 'sender@example.test', imapPassword: 'private-imap', footer: '' }
let clientIndex = 0
afterEach(() => vi.unstubAllEnvs())
function client(fetch: typeof globalThis.fetch) { return createClient<WinnrSmtpDatabase>('https://fixture.supabase.co','synthetic-service-key',{ global: { fetch }, auth: { persistSession: false, autoRefreshToken: false, storageKey: `smtp-fixture-${clientIndex++}` } }) }
describe('Winnr private SMTP storage boundary', () => {
  it('sends encrypted rows to the atomic RPC and strips any accidental private response fields', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json([{ providerMailboxId: 'mb-1', email: secret.fromEmail, accountId: 'mapped-account', syncedAt: 'now', credentials_ciphertext: 'must-not-leave' }]))
    const repo = createWinnrSmtpRepository({ client: client(fetch) })
    const result = await repo.persist({ actorId: org, organizationId: org, connectionId: conn, connectionVersion: 1, mailboxes: [{ providerMailboxId: 'mb-1', email: secret.fromEmail, displayName: 'Sender', ciphertext: encrypt(JSON.stringify(secret)) }] })
    expect(String(fetch.mock.calls[0]?.[0])).toContain('/rpc/winnr_sync_smtp_credentials')
    expect(JSON.stringify(result)).not.toContain('must-not-leave')
    expect(JSON.stringify(result)).not.toContain('synthetic-private-password')
  })
  it('queries only nonsecret status columns with organization and connection version filters', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json([{ provider_mailbox_id: 'mb-1', email: secret.fromEmail, account_id: 'mapped-account', synced_at: 'now' }]))
    const status = await createWinnrSmtpRepository({ client: client(fetch) }).status(org,conn,2)
    const url = new URL(String(fetch.mock.calls[0]?.[0]))
    expect(url.searchParams.get('select')).not.toContain('ciphertext')
    expect(url.searchParams.get('organization_id')).toBe(`eq.${org}`)
    expect(url.searchParams.get('connection_id')).toBe(`eq.${conn}`)
    expect(url.searchParams.get('connection_version')).toBe('eq.2')
    expect(status[0]?.accountId).toBe('mapped-account')
  })
  it('refuses stale connections and sanitized malformed ciphertext without returning raw secrets', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async address => String(address).includes('/winnr_connections?') ? Response.json(null) : Response.json({ credentials_ciphertext: 'private-password-malformed', email: secret.fromEmail, provider_mailbox_id: 'mb-1' }))
    const repo = createWinnrSmtpRepository({ client: client(fetch) })
    const input = { organizationId: org, connectionId: conn, connectionVersion: 1, mailboxId: 'mb-1' }
    expect(await repo.loadCredentials(input)).toBeNull(); expect(fetch).toHaveBeenCalledTimes(1)
    fetch.mockImplementation(async address => String(address).includes('/winnr_connections?') ? Response.json({ id: conn }) : Response.json({ credentials_ciphertext: 'private-password-malformed', email: secret.fromEmail, provider_mailbox_id: 'mb-1' }))
    await expect(repo.loadCredentials(input)).rejects.toThrow('Private SMTP credentials are unavailable')
  })
  it('has no anon-key fallback', () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY',''); vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY','synthetic-anon')
    expect(() => createWinnrSmtpRepository()).toThrow('Winnr storage is not configured')
  })
  it('aborts an expired credential read instead of returning a late secret', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
    }))
    const repo = createWinnrSmtpRepository({ client: client(fetch), deadlineAt: Date.now() - 1 })
    await expect(repo.loadCredentials({ organizationId: org, connectionId: conn, connectionVersion: 1, mailboxId: 'mb-1' })).rejects.toThrow('Private SMTP credential storage failed')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })
})
