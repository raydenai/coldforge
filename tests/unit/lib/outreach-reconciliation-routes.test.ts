import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { WinnrApiError } from '@/lib/winnr/server'

const b = vi.hoisted(() => ({ auth: vi.fn(), repo: vi.fn(), call: vi.fn() }))
vi.mock('@/app/api/winnr/_shared', async (original) => ({
  ...(await original<typeof import('@/app/api/winnr/_shared')>()),
  resolveAuthContext: b.auth,
}))
vi.mock('@/lib/outreach/reconciliation/database', () => ({ createReconciliationRepository: b.repo }))

import { GET, POST } from '@/app/api/outreach/reconciliation/route'

const actor = '11111111-1111-4111-8111-111111111111'
const org = '22222222-2222-4222-8222-222222222222'
const attemptId = '33333333-3333-4333-8333-333333333333'
const fingerprint = 'a'.repeat(64)
const listPayload = {
  items: [],
  counts: { unconfirmed: 1, accepted: 0, held: 1, available: 0, conflicting: 0, missing: 1 },
  recent: [],
  generatedAt: '2026-10-05T00:00:00.000Z',
}

const get = (query = '') => new NextRequest(`https://fixture.example/api/outreach/reconciliation${query}`)
const post = (body: unknown, origin: string | null = 'https://fixture.example') =>
  new NextRequest('https://fixture.example/api/outreach/reconciliation', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  })

beforeEach(() => {
  vi.clearAllMocks()
  b.auth.mockResolvedValue({ userId: actor, organizationId: org, role: 'owner' })
  b.repo.mockReturnValue({ call: b.call })
  b.call.mockResolvedValue(listPayload)
})

describe('reconciliation HTTP authority', () => {
  it('unauthenticated requests never construct privileged storage', async () => {
    b.auth.mockRejectedValue(new WinnrApiError(401, 'unauthenticated', 'Authentication required'))
    expect((await GET(get())).status).toBe(401)
    expect(b.repo).not.toHaveBeenCalled()
  })

  it('ordinary members cannot construct privileged storage', async () => {
    b.auth.mockResolvedValue({ userId: actor, organizationId: org, role: 'member' })
    expect((await GET(get())).status).toBe(403)
    expect(b.repo).not.toHaveBeenCalled()
  })

  it.each([null, 'https://foreign.example'])('missing/foreign Origin refused before storage %s', async (origin) => {
    expect((await POST(post({ attemptId }, origin))).status).toBe(403)
    expect(b.repo).not.toHaveBeenCalled()
  })

  it('browser-selected outcome, proof, body or recipient is rejected before storage', async () => {
    for (const extra of [{ outcome: 'accepted' }, { proof: { receiptId: attemptId } }, { body: 'mark sent' }, { recipient: 'x@example.test' }]) {
      const response = await POST(post({ attemptId, ...extra }))
      expect(response.status).toBe(400)
    }
    expect(b.repo).not.toHaveBeenCalled()
  })

  it('GET lists held attempts with measured counts', async () => {
    const response = await GET(get())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ counts: { unconfirmed: 1 } })
    expect(b.call).toHaveBeenCalledWith(actor, org, 'list', {})
  })

  it('GET status selects one attempt', async () => {
    b.call.mockResolvedValue({ attemptId, kind: 'campaign', status: 'unknown', canReconcile: true, reason: null, evidence: 'available', ageSeconds: 5, recipient: 'lead@example.test', sender: 'sender@example.test', campaignId: null, threadId: null, canonicalThreadId: null, sourceReplyId: null, fingerprint, auditId: null })
    const response = await GET(get(`?attemptId=${attemptId}`))
    expect(response.status).toBe(200)
    expect(b.call).toHaveBeenCalledWith(actor, org, 'status', { attemptId })
  })

  it('POST forwards only attemptId and expected fingerprint and never leaks secrets', async () => {
    b.call.mockResolvedValue({ status: 'accepted', alreadyAccepted: false, attemptId, kind: 'campaign', auditId: attemptId, eventId: attemptId, sourceReceiptId: attemptId, providerMessageId: '<relayed@example.test>', recipient: 'lead@example.test' })
    const response = await POST(post({ attemptId, fingerprint }))
    expect(response.status).toBe(200)
    expect(b.call).toHaveBeenCalledWith(actor, org, 'reconcile', { attemptId, fingerprint })
    const text = await response.text()
    expect(text).not.toMatch(/token|ciphertext|secret|api[_-]?key/i)
  })

  it('POST returns an explicit held response when proof is missing', async () => {
    b.call.mockResolvedValue({ status: 'held', reason: 'evidence_missing', attemptId, kind: 'campaign', evidence: 'missing' })
    const response = await POST(post({ attemptId }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'held', reason: 'evidence_missing' })
  })

  it('POST includes the expected fingerprint only when the client sent one', async () => {
    b.call.mockResolvedValue({ status: 'held', reason: 'fingerprint_mismatch', attemptId })
    await POST(post({ attemptId }))
    expect(b.call).toHaveBeenCalledWith(actor, org, 'reconcile', { attemptId })
  })

  it('a read failure surfaces as unavailable rather than a fake zero count', async () => {
    b.call.mockRejectedValue(new WinnrApiError(503, 'service_unavailable', 'Reconciliation storage failed'))
    expect((await GET(get())).status).toBe(503)
  })
})
