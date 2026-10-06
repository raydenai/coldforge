import { describe, expect, it, vi } from 'vitest'
import { WinnrApiError } from '@/lib/winnr/server'
import {
  buildReconcilePayload,
  canReconcile,
  classifyEvidence,
  evidenceLabel,
  formatAge,
  heldGuidance,
} from '@/lib/outreach/reconciliation/core'
import { reconciliationRequestSchema, type ReconciliationList } from '@/lib/outreach/reconciliation/schemas'
import {
  readReconciliationState,
  reconcileDispatchAttempt,
  requireReconciliationManager,
  type ReconciliationDeps,
} from '@/lib/outreach/reconciliation/service'

const actor = { userId: '11111111-1111-4111-8111-111111111111', organizationId: '22222222-2222-4222-8222-222222222222', role: 'owner' as const }
const attemptId = '33333333-3333-4333-8333-333333333333'
const fingerprint = 'a'.repeat(64)

const listPayload: ReconciliationList = {
  items: [
    {
      attemptId,
      kind: 'campaign',
      status: 'unknown',
      createdAt: '2026-10-05T00:00:00.000Z',
      authorizedAt: '2026-10-05T00:00:01.000Z',
      ageSeconds: 120,
      recipient: 'lead@example.test',
      sender: 'sender@example.test',
      campaignId: '44444444-4444-4444-8444-444444444444',
      threadId: null,
      sourceReplyId: null,
      fingerprint,
      evidence: 'available',
      providerMessageId: '<relayed@example.test>',
    },
  ],
  counts: { unconfirmed: 1, accepted: 2, held: 1, available: 1, conflicting: 0, missing: 0 },
  recent: [],
  generatedAt: '2026-10-05T00:05:00.000Z',
}

function deps(result: unknown): ReconciliationDeps & { call: ReturnType<typeof vi.fn> } {
  const call = vi.fn().mockResolvedValue(result)
  return { repository: { call }, call }
}

describe('reconciliation evidence policy', () => {
  it('classifies exactly one exact mapping as available and everything else as held', () => {
    expect(classifyEvidence(0, 0)).toBe('missing')
    expect(classifyEvidence(1, 1)).toBe('available')
    expect(classifyEvidence(1, 0)).toBe('conflicting')
    expect(classifyEvidence(2, 1)).toBe('conflicting')
    expect(classifyEvidence(2, 2)).toBe('conflicting')
  })

  it('only enables reconcile for available, non-accepted evidence', () => {
    expect(canReconcile({ status: 'unknown', evidence: 'available' })).toBe(true)
    expect(canReconcile({ status: 'dispatching', evidence: 'available' })).toBe(true)
    expect(canReconcile({ status: 'accepted', evidence: 'available' })).toBe(false)
    expect(canReconcile({ status: 'unknown', evidence: 'missing' })).toBe(false)
    expect(canReconcile({ status: 'unknown', evidence: 'conflicting' })).toBe(false)
  })

  it('never tells an operator to resend for a missing receipt', () => {
    const guidance = heldGuidance('evidence_missing')
    expect(guidance).toMatch(/Winnr webhook association/i)
    expect(guidance).toMatch(/manual inbox sync/i)
    expect(guidance).toMatch(/Do not resend/i)
    expect(evidenceLabel('missing')).toMatch(/No relay evidence/i)
  })

  it('formats bounded ages and payloads without inventing fields', () => {
    expect(formatAge(30)).toBe('30s')
    expect(formatAge(90)).toBe('1m')
    expect(formatAge(3660)).toBe('1h 1m')
    expect(formatAge(-5)).toBe('unknown age')
    expect(buildReconcilePayload({ attemptId })).toEqual({ attemptId })
    expect(buildReconcilePayload({ attemptId, fingerprint })).toEqual({ attemptId, fingerprint })
  })
})

describe('reconciliation request boundary', () => {
  it('accepts only attemptId and an optional sha-256 fingerprint', () => {
    expect(reconciliationRequestSchema.parse({ attemptId })).toEqual({ attemptId })
    expect(reconciliationRequestSchema.parse({ attemptId, fingerprint })).toEqual({ attemptId, fingerprint })
    expect(() => reconciliationRequestSchema.parse({ attemptId, fingerprint: 'short' })).toThrow()
    expect(() => reconciliationRequestSchema.parse({ attemptId, outcome: 'accepted' })).toThrow()
    expect(() => reconciliationRequestSchema.parse({ attemptId, proof: { receiptId: 'x' } })).toThrow()
    expect(() => reconciliationRequestSchema.parse({ attemptId, body: 'mark sent' })).toThrow()
    expect(() => reconciliationRequestSchema.parse({ attemptId, recipient: 'lead@example.test' })).toThrow()
  })
})

describe('reconciliation service authority and read failures', () => {
  it('rejects ordinary members before any privileged repository is used', async () => {
    const fake = deps(listPayload)
    await expect(readReconciliationState({ ...actor, role: 'member' }, {}, fake)).rejects.toMatchObject({ status: 403 })
    expect(fake.call).not.toHaveBeenCalled()
    expect(() => requireReconciliationManager({ ...actor, role: 'member' })).toThrow(WinnrApiError)
  })

  it('reads the held list through the service-only RPC', async () => {
    const fake = deps(listPayload)
    await expect(readReconciliationState(actor, {}, fake)).resolves.toMatchObject({ counts: { accepted: 2, unconfirmed: 1 } })
    expect(fake.call).toHaveBeenCalledWith(actor.userId, actor.organizationId, 'list', {})
  })

  it('propagates a read failure instead of returning a fake zero measurement', async () => {
    const call = vi.fn().mockRejectedValue(new WinnrApiError(503, 'service_unavailable', 'Reconciliation storage failed'))
    await expect(readReconciliationState(actor, {}, { repository: { call } })).rejects.toMatchObject({ status: 503 })
  })

  it('forwards only the attempt id and expected fingerprint to the RPC', async () => {
    const fake = deps({ status: 'held', reason: 'evidence_missing', attemptId })
    const result = await reconcileDispatchAttempt(actor, { attemptId, fingerprint }, fake)
    expect(result).toMatchObject({ status: 'held', reason: 'evidence_missing' })
    expect(fake.call).toHaveBeenCalledWith(actor.userId, actor.organizationId, 'reconcile', { attemptId, fingerprint })
  })

  it('returns an idempotent accepted result without a second effect', async () => {
    const fake = deps({ status: 'accepted', alreadyAccepted: true, attemptId, kind: 'campaign' })
    await expect(reconcileDispatchAttempt(actor, { attemptId }, fake)).resolves.toMatchObject({ status: 'accepted', alreadyAccepted: true })
    expect(fake.call).toHaveBeenCalledTimes(1)
  })

  it('accepts an idempotent result with no reconciliation audit (transport-settled attempt)', async () => {
    const fake = deps({ status: 'accepted', alreadyAccepted: true, attemptId, kind: 'campaign', auditId: null })
    const outcome = await reconcileDispatchAttempt(actor, { attemptId }, fake)
    expect(outcome).toMatchObject({ status: 'accepted', alreadyAccepted: true, auditId: null })
  })
})
