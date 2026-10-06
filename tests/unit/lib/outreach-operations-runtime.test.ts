import { describe, expect, it, vi } from 'vitest'
import type { WinnrAuthContext } from '@/lib/winnr/server'

const mocks = vi.hoisted(() => ({
  dispatchCampaign: vi.fn(),
  createEmailDispatchDeps: vi.fn(),
}))

vi.mock('@/lib/outreach/dispatch', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/outreach/dispatch')>()
  return { ...original, dispatchCampaign: mocks.dispatchCampaign }
})
vi.mock('@/lib/outreach/dispatch-runtime', () => ({ createEmailDispatchDeps: mocks.createEmailDispatchDeps }))

import { createDispatchPhasePort } from '@/lib/outreach/operations/runtime'

const actor: WinnrAuthContext = { userId: '22222222-2222-4222-8222-222222222222', organizationId: '11111111-1111-4111-8111-111111111111', role: 'owner' }
const CAMPAIGN = '33333333-3333-4333-8333-333333333333'

describe('campaign dispatch settlement precedence', () => {
  it('keeps an accepted SMTP receipt held when the durable top-level outcome is unknown', async () => {
    mocks.createEmailDispatchDeps.mockReturnValue({})
    mocks.dispatchCampaign.mockResolvedValue({
      outcomes: [
        {
          attemptId: 'held-reference',
          receipt: { outcome: 'accepted', messageId: '<accepted@example.test>', recipient: 'lead@example.test' },
          outcome: 'unknown',
          code: 'receipt_persistence_failed',
        },
      ],
    })
    const outcome = await createDispatchPhasePort()(actor, CAMPAIGN)
    expect(outcome).toEqual({ status: 'held', reason: 'receipt_persistence_failed', attemptId: 'held-reference', modelCalls: 0, smtpAttempts: 1 })
  })

  it('reports a bare accepted receipt as completed', async () => {
    mocks.createEmailDispatchDeps.mockReturnValue({})
    mocks.dispatchCampaign.mockResolvedValue({
      outcomes: [{ attemptId: 'accepted-reference', receipt: { outcome: 'accepted', messageId: '<accepted@example.test>', recipient: 'lead@example.test' } }],
    })
    const outcome = await createDispatchPhasePort()(actor, CAMPAIGN)
    expect(outcome).toEqual({ status: 'completed', reason: 'smtp_accepted', attemptId: 'accepted-reference', modelCalls: 0, smtpAttempts: 1 })
  })

  it('passes the absolute request deadline into the dispatch dependency factory', async () => {
    mocks.createEmailDispatchDeps.mockReturnValue({})
    mocks.dispatchCampaign.mockResolvedValue({ outcomes: [] })
    await createDispatchPhasePort()(actor, CAMPAIGN, 12_345)
    expect(mocks.createEmailDispatchDeps).toHaveBeenCalledWith(actor, 12_345)
  })
})
