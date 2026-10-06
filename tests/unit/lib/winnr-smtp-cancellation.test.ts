import type { Readable } from 'node:stream'
import { EventEmitter } from 'node:events'
import type SMTPConnection from 'nodemailer/lib/smtp-connection'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createWinnrSmtpTransport, fingerprintWinnrSmtpMessage } from '@/lib/winnr/smtp-transport'
const state = vi.hoisted(() => ({ phase: 'connect', connect: undefined as (() => void) | undefined, login: undefined as (() => void) | undefined, close: vi.fn(), destroy: vi.fn(), send: vi.fn(), options: undefined as SMTPConnection.Options | undefined }))
vi.mock('nodemailer/lib/smtp-connection', () => ({ default: class extends EventEmitter {
  allowsAuth = true
  version = 'fake-low-level'
  _socket = { destroy: state.destroy }
  constructor(options: SMTPConnection.Options) { super(); state.options = options }
  connect(callback: () => void) { state.connect = callback; if (state.phase !== 'connect') callback() }
  login(_auth: unknown, callback: () => void) { state.login = callback; if (['data', 'accepted'].includes(state.phase)) callback() }
  send(_envelope: SMTPConnection.Envelope, stream: Readable, callback: (error: null, info: SMTPConnection.SentMessageInfo) => void) {
    state.send()
    if (state.phase === 'accepted') {
      stream.resume()
      stream.once('end', () => callback(null, { accepted: [message.to], rejected: [], response: '250', envelopeTime: 0, messageTime: 0, messageSize: 0 }))
    }
  }
  close() { state.close(); this.emit('end') }
} }))
const message = { from: 'sender@example.test', to: 'recipient@example.test', subject: 'Hello', text: 'Body', messageId: '<attempt@example.test>' }
const input = { organizationId: 'org', connectionId: 'conn', connectionVersion: 1, mailboxId: 'mailbox', claimToken: 'claim', message }
function transport() {
  return createWinnrSmtpTransport({ sendTimeoutMs: 10,
    resolve: async () => [{ address: '8.8.8.8', family: 4 }],
    loadCredentials: async () => ({ providerMailboxId: 'mailbox', domain: 'example.test', fromEmail: message.from, fromName: '', smtpHost: 'smtp.example.test', smtpPort: 465, smtpUsername: message.from, smtpPassword: 'synthetic', imapHost: 'imap.example.test', imapPort: 993, imapUsername: message.from, imapPassword: 'synthetic', footer: '' }),
    authorizeClaim: async () => ({ ...input, fingerprint: fingerprintWinnrSmtpMessage(message), attemptId: 'attempt' }),
  })
}
beforeEach(() => { vi.clearAllMocks(); state.connect = undefined; state.login = undefined })
describe('installed Nodemailer MIME boundary with fake underlying SMTP connection', () => {
  it('keeps actual Nodemailer MIME compilation and accepted receipt behavior', async () => {
    state.phase = 'accepted'
    expect(await transport().send(input)).toEqual({ outcome: 'accepted', recipient: message.to, messageId: message.messageId })
    expect(state.send).toHaveBeenCalledOnce()
    expect(state.close).toHaveBeenCalledOnce()
    expect(state.destroy).not.toHaveBeenCalled()
  })
  it('destroys a socket during DATA but preserves unknown and spends the claim', async () => {
    state.phase = 'data'
    const sender = transport()
    expect((await sender.send(input)).outcome).toBe('unknown')
    expect(state.send).toHaveBeenCalledOnce()
    expect(state.destroy).toHaveBeenCalledOnce()
    expect((await sender.send(input)).outcome).toBe('rejected')
    expect(state.send).toHaveBeenCalledOnce()
  })
  for (const phase of ['connect', 'auth']) it(`cancels actual connection during ${phase} and blocks late DATA`, async () => {
    state.phase = phase
    const sender = transport()
    expect(await sender.send(input)).toEqual({ outcome: 'unknown', code: 'smtp_outcome_unknown' })
    expect(state.close).toHaveBeenCalled()
    expect(state.destroy).toHaveBeenCalledOnce()
    expect(state.options).toMatchObject({ host: '8.8.8.8', secure: true, tls: { servername: 'smtp.example.test', rejectUnauthorized: true } })
    state.connect?.(); state.login?.()
    expect(state.send).not.toHaveBeenCalled()
    expect(await sender.send(input)).toEqual({ outcome: 'rejected', code: 'claim_already_used' })
  })
})
