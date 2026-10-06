import { describe, expect, it } from 'vitest'
import {
  isAttentionStatus,
  isSuccessfulTick,
  operationsReadinessSchema,
  operationsStatusSchema,
} from '@/lib/outreach/operations/core'

const validStatus = {
  control: { revision: 1, automationEnabled: false, schedulerPaused: false, masterStop: false, enabledAt: null, updatedAt: null },
  heartbeat: {
    revision: 0,
    lastAttemptAt: null,
    lastAttemptPhase: null,
    lastAttemptStatus: null,
    lastAttemptDetail: null,
    lastSuccessAt: null,
    consecutiveFailures: 0,
  },
  stats: { attemptsAccepted: 0, attemptsUnknown: 0, attemptsReserved: 0, sendsAcceptedToday: 0, agentRunsUnknown: 0, bodyPending: 0, decisionsPending: 0 },
  attention: [{ kind: 'body_pending', referenceId: 'msg-1', reason: 'pending', observedAt: null, fingerprint: null }],
  runs: [
    {
      id: 'run-1',
      phase: 'decision',
      status: 'held',
      reason: 'model_outcome_unknown',
      campaignId: null,
      referenceId: null,
      referenceFingerprint: null,
      attemptId: null,
      decisionId: null,
      modelCalls: 1,
      smtpAttempts: 0,
      startedAt: '2026-01-01T00:00:00.000Z',
      settledAt: '2026-01-01T00:00:01.000Z',
    },
  ],
}

describe('operations core', () => {
  it('classifies attention vs successful statuses', () => {
    expect(isAttentionStatus('held')).toBe(true)
    expect(isAttentionStatus('blocked')).toBe(true)
    expect(isAttentionStatus('completed')).toBe(false)
    expect(isSuccessfulTick('completed')).toBe(true)
    expect(isSuccessfulTick('idle')).toBe(true)
    expect(isSuccessfulTick('blocked')).toBe(false)
  })

  it('accepts a complete status payload', () => {
    expect(operationsStatusSchema.parse(validStatus)).toEqual(validStatus)
  })

  it('rejects a status payload missing counters rather than defaulting them', () => {
    const { stats: _stats, ...missing } = validStatus
    void _stats
    expect(operationsStatusSchema.safeParse(missing).success).toBe(false)
  })

  it('rejects an unknown phase in a run', () => {
    expect(
      operationsStatusSchema.safeParse({ ...validStatus, runs: [{ ...validStatus.runs[0], phase: 'nope' }] }).success,
    ).toBe(false)
  })

  it('validates readiness blockers', () => {
    expect(
      operationsReadinessSchema.parse({
        ready: false,
        activeCampaigns: 0,
        configuredCampaigns: 0,
        blockers: [{ code: 'winnr_connection', label: 'Connect Winnr', href: '/winnr' }],
      }).blockers[0]?.code,
    ).toBe('winnr_connection')
  })
})
