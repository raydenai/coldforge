import { describe, expect, it, vi } from 'vitest'
import { createWinnrSmtpTransport, fingerprintWinnrSmtpMessage, type WinnrSmtpTransportDeps, isPublicSmtpAddress } from '@/lib/winnr/smtp-transport'
const message = { from: 'sender@example.test', to: 'recipient@example.test', subject: 'Hello', text: 'Plain body', html: '<p>HTML</p>', messageId: '<send-1@example.test>', inReplyTo: '<thread-1@example.test>', references: ['<thread-1@example.test>'], headers: { 'List-Unsubscribe': '<https://app.example/unsubscribe/1>' } }
const input = { organizationId: 'org-1', connectionId: 'conn-1', connectionVersion: 1, mailboxId: 'mb-1', claimToken: 'opaque-token', message }
function deps() {
  return {
    loadCredentials: vi.fn(async () => ({ providerMailboxId: 'mb-1', fromEmail: message.from, fromName: 'Sender', smtpHost: 'smtp.example.test', smtpPort: 465 as const, smtpUsername: message.from, smtpPassword: 'private-password', imapHost: 'imap.example.test', imapPort: 993 as const, imapUsername: message.from, imapPassword: 'imap-secret', footer: '', domain: 'example.test' })),
    resolve: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]),
    authorizeClaim: vi.fn(async () => ({ organizationId: input.organizationId, connectionId: input.connectionId, connectionVersion: 1, mailboxId: input.mailboxId, claimToken: input.claimToken, fingerprint: fingerprintWinnrSmtpMessage(message), attemptId: 'attempt-1' })),
    createTransport: vi.fn<NonNullable<WinnrSmtpTransportDeps['createTransport']>>((options) => { void options; return { sendMail: vi.fn(async () => ({ accepted: [message.to], rejected: [], messageId: message.messageId })), close: vi.fn() } }),
  }
}
describe('single-attempt claim-bound Winnr SMTP transport', () => {
  it('pins public DNS and verified implicit TLS while preserving message and thread headers', async () => {
    const d = deps(); const result = await createWinnrSmtpTransport(d).send(input)
    expect(result).toEqual({ outcome: 'accepted', messageId: message.messageId, recipient: message.to })
    expect(d.createTransport.mock.calls[0]?.[0]).toMatchObject({ host: '8.8.8.8', port: 465, secure: true, pool: false, tls: { servername: 'smtp.example.test', rejectUnauthorized: true } })
    expect(d.createTransport.mock.results[0]?.value.sendMail).toHaveBeenCalledWith(expect.objectContaining({ text: message.text, html: message.html, inReplyTo: message.inReplyTo, references: message.references, headers: message.headers }))
  })
  it('refuses private DNS and header injection without SMTP handoff', async () => {
    const d = deps(); d.resolve.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    expect((await createWinnrSmtpTransport(d).send(input)).outcome).toBe('rejected')
    expect(d.createTransport).not.toHaveBeenCalled(); expect(d.authorizeClaim).not.toHaveBeenCalled()
    const safe = deps(); expect((await createWinnrSmtpTransport(safe).send({ ...input, message: { ...message, subject: 'Hello\r\nBcc: evil@example.test' } })).outcome).toBe('rejected')
    expect(safe.createTransport).not.toHaveBeenCalled()
  })
  it('never authorizes or opens a socket when the credential read is aborted by the deadline', async () => {
    const d = deps(); d.loadCredentials.mockRejectedValue(new Error('credential deadline exceeded'))
    expect(await createWinnrSmtpTransport(d).send(input)).toEqual({ outcome: 'rejected', code: 'sender_unavailable' })
    expect(d.authorizeClaim).not.toHaveBeenCalled(); expect(d.createTransport).not.toHaveBeenCalled()
  })
  it('rejects changed content under an approved fingerprint', async () => {
    const d = deps(); expect((await createWinnrSmtpTransport(d).send({ ...input, message: { ...message, text: 'Unapproved changed copy' } })).outcome).toBe('rejected')
    expect(d.createTransport).not.toHaveBeenCalled()
  })
  it('makes no second attempt for the same claim and classifies explicit rejection', async () => {
    const d = deps(); const sendMail = vi.fn(async () => ({ accepted: [], rejected: [message.to], messageId: message.messageId }))
    d.createTransport.mockReturnValue({ sendMail, close: vi.fn() })
    const transport = createWinnrSmtpTransport(d)
    expect((await transport.send(input)).outcome).toBe('rejected')
    expect((await transport.send(input)).outcome).toBe('rejected')
    expect(sendMail).toHaveBeenCalledTimes(1)
  })
  it('rejects reserved IP ranges, mapped addresses and mixed private/public DNS', async () => {
    for (const address of ['0.0.0.0','10.0.0.1','100.64.0.1','169.254.169.254','192.0.2.1','198.18.0.1','203.0.113.1','224.0.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:1::1','2001:db8::1','3fff::1']) expect(isPublicSmtpAddress(address), address).toBe(false)
    expect(isPublicSmtpAddress('2001:4860:4860::8888')).toBe(true)
    const d = deps(); d.resolve.mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }])
    expect((await createWinnrSmtpTransport(d).send(input)).outcome).toBe('rejected')
    expect(d.createTransport).not.toHaveBeenCalled()
  })
  it('times out once, closes the connection and retains unknown outcome', async () => {
    const d = deps(); const sendMail = vi.fn(() => new Promise<never>(() => {})); const close = vi.fn()
    d.createTransport.mockReturnValue({ sendMail, close })
    expect((await createWinnrSmtpTransport({ ...d, sendTimeoutMs: 5 }).send(input)).outcome).toBe('unknown')
    expect(sendMail).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1)
  })
  it('does not allow caller mutation after the approved message snapshot', async () => {
    const d = deps(); const mutable = { ...message, headers: { ...message.headers }, references: [...message.references] }
    const pending = createWinnrSmtpTransport(d).send({ ...input, message: mutable })
    mutable.subject = 'Unapproved'; mutable.headers['List-Unsubscribe'] = '<https://evil.test>'
    expect((await pending).outcome).toBe('accepted')
    expect(d.createTransport.mock.results[0]?.value.sendMail).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Hello', headers: message.headers }))
  })
  it('prevents concurrent reuse of a claim from creating two SMTP attempts', async () => {
    const d = deps(); const transport = createWinnrSmtpTransport(d)
    const results = await Promise.all([transport.send(input), transport.send(input)])
    expect(results.map(result => result.outcome).sort()).toEqual(['accepted','rejected'])
    expect(d.createTransport).toHaveBeenCalledTimes(1)
  })
  it('holds ambiguous errors and mismatched receipts as unknown without retries or secret errors', async () => {
    const d = deps(); const sendMail = vi.fn(async () => { throw new Error('ETIMEDOUT private-password') })
    d.createTransport.mockReturnValue({ sendMail, close: vi.fn() })
    const result = await createWinnrSmtpTransport(d).send(input)
    expect(result.outcome).toBe('unknown'); expect(JSON.stringify(result)).not.toContain('private-password'); expect(sendMail).toHaveBeenCalledTimes(1)
    const wrong = deps(); wrong.createTransport.mockReturnValue({ sendMail: vi.fn(async () => ({ accepted: ['other@example.test'], rejected: [], messageId: message.messageId })), close: vi.fn() })
    expect((await createWinnrSmtpTransport(wrong).send(input)).outcome).toBe('unknown')
  })
})
