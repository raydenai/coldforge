import { describe, expect, it, vi } from 'vitest'
import type { OutreachEventService } from '@/lib/outreach/events'
import type { WinnrAuthContext } from '@/lib/winnr/server'
import type { OperationsClaim, OperationsRepository, PhaseOutcome } from '@/lib/outreach/operations/core'
import {
  BODY_LEASE_SECONDS,
  createBodyPhasePort,
  executeClaimedPhase,
  readReceiptId,
  runOperationsTick,
  SETTLEMENT_RESERVE_MS,
  type OperationsPorts,
} from '@/lib/outreach/operations/scheduler'

const ORG = '11111111-1111-4111-8111-111111111111'
const ACTOR = '22222222-2222-4222-8222-222222222222'
const CAMPAIGN = '33333333-3333-4333-8333-333333333333'
const RECEIPT = '44444444-4444-4444-8444-444444444444'

function claimed(overrides: Partial<OperationsClaim> = {}): OperationsClaim {
  return {
    result: 'claimed',
    runId: '55555555-5555-4555-8555-555555555555',
    leaseToken: '66666666-6666-4666-8666-666666666666',
    leaseExpiresAt: '2030-01-01T00:00:00.000Z',
    organizationId: ORG,
    actorId: ACTOR,
    role: 'owner',
    phase: 'campaign',
    campaignId: CAMPAIGN,
    scopeKey: 'campaign',
    ...overrides,
  }
}

function repository(overrides: Partial<OperationsRepository> = {}): OperationsRepository {
  return {
    claim: vi.fn().mockResolvedValue(claimed()),
    settle: vi.fn().mockResolvedValue({ result: 'settled' }),
    read: vi.fn(),
    readiness: vi.fn(),
    control: vi.fn(),
    ...overrides,
  } as unknown as OperationsRepository
}

function ports(overrides: Partial<OperationsPorts> = {}): OperationsPorts {
  const outcome: PhaseOutcome = { status: 'completed', modelCalls: 0, smtpAttempts: 0 }
  return {
    repository: repository(),
    dispatch: vi.fn().mockResolvedValue(outcome),
    body: vi.fn().mockResolvedValue(outcome),
    decision: vi.fn().mockResolvedValue(outcome),
    reply: vi.fn().mockResolvedValue(outcome),
    now: () => 1_000,
    ...overrides,
  }
}

describe('bounded operations tick', () => {
  it('claims, runs exactly one phase and settles with the exact lease', async () => {
    const repo = repository()
    const p = ports({ repository: repo })
    const result = await runOperationsTick(p)
    expect(result.result).toBe('settled')
    expect(result.phase).toBe('campaign')
    expect(p.dispatch).toHaveBeenCalledTimes(1)
    expect(p.body).not.toHaveBeenCalled()
    expect(repo.settle).toHaveBeenCalledWith(
      expect.objectContaining({ scopeKey: 'campaign', leaseToken: '66666666-6666-4666-8666-666666666666', leaseExpiresAt: '2030-01-01T00:00:00.000Z' }),
    )
  })

  it('returns idle without settling when no phase is claimable', async () => {
    const repo = repository({ claim: vi.fn().mockResolvedValue({ result: 'idle', reason: 'no_eligible_organization' }) })
    const p = ports({ repository: repo })
    expect(await runOperationsTick(p)).toEqual({ result: 'idle', reason: 'no_eligible_organization' })
    expect(repo.settle).not.toHaveBeenCalled()
    expect(p.dispatch).not.toHaveBeenCalled()
  })

  it('holds without starting an effect once the deadline has passed', async () => {
    const repo = repository()
    const p = ports({ repository: repo, now: () => 5_000 })
    const result = await runOperationsTick(p, { deadlineMs: 0 })
    expect(result.status).toBe('held')
    expect(result.reason).toBe('deadline_before_effect')
    expect(p.dispatch).not.toHaveBeenCalled()
    expect(repo.settle).toHaveBeenCalledWith(expect.objectContaining({ status: 'held', reason: 'deadline_before_effect' }))
  })

  it('reports an unsettled tick when the lease fence rejects settlement', async () => {
    const repo = repository({ settle: vi.fn().mockResolvedValue({ result: 'stale' }) })
    const result = await runOperationsTick(ports({ repository: repo }))
    expect(result.result).toBe('unsettled')
    expect(result.reason).toBe('settlement_rejected')
  })

  it('does not invoke a model or SMTP phase for a campaign with no active id', async () => {
    const repo = repository({ claim: vi.fn().mockResolvedValue(claimed({ campaignId: null, scopeKey: 'campaign' })) })
    const p = ports({ repository: repo })
    const result = await runOperationsTick(p)
    expect(result.status).toBe('idle')
    expect(result.reason).toBe('no_active_campaign')
    expect(p.dispatch).not.toHaveBeenCalled()
  })

  it('surfaces an unexpected phase throw as a blocked settlement', async () => {
    const p = ports({ dispatch: vi.fn().mockRejectedValue(new Error('boom')) })
    const result = await runOperationsTick(p)
    expect(result.status).toBe('blocked')
    expect(result.reason).toBe('phase_error')
  })

  it('carries the absolute request deadline into claim, phase and settlement with a settle reserve', async () => {
    const repo = repository()
    const p = ports({ repository: repo })
    const result = await runOperationsTick(p, { deadlineAt: 30_000 })
    expect(result.result).toBe('settled')
    expect(repo.claim).toHaveBeenCalledWith(expect.objectContaining({ deadlineAt: 30_000 }))
    expect(p.dispatch).toHaveBeenCalledWith(expect.any(Object), CAMPAIGN, 30_000 - SETTLEMENT_RESERVE_MS)
    expect(repo.settle).toHaveBeenCalledWith(expect.objectContaining({ deadlineAt: 30_000 }))
  })
})

describe('body consumer port', () => {
  function events(overrides: Partial<OutreachEventService> = {}) {
    const job = {
      outboxId: '77777777-7777-4777-8777-777777777777',
      eventId: '88888888-8888-4888-8888-888888888888',
      attempts: 1,
      leaseExpiresAt: '2030-01-01T00:00:00.000Z',
      event: {
        version: 1 as const,
        organizationId: ORG,
        type: 'email.received',
        source: 'winnr',
        sourceEventId: 'evt-1',
        occurredAt: '2026-01-01T00:00:00.000Z',
        correlationId: null,
        causationId: null,
        subject: {},
        data: { receiptId: RECEIPT, connectionId: ORG },
      },
    }
    return {
      append: vi.fn(),
      claim: vi.fn().mockResolvedValue({ result: 'claimed', jobs: [job] }),
      ack: vi.fn().mockResolvedValue({ result: 'acked' }),
      fail: vi.fn().mockResolvedValue({ result: 'retryable', attempts: 1 }),
      markUnknown: vi.fn().mockResolvedValue({ result: 'unknown' }),
      ...overrides,
    } as unknown as OutreachEventService
  }

  const actor: WinnrAuthContext = { userId: ACTOR, organizationId: ORG, role: 'owner' }

  it('reads the receipt id from the canonical event payload', () => {
    expect(readReceiptId({ type: 'email.received', data: { receiptId: RECEIPT } })).toBe(RECEIPT)
    expect(readReceiptId({ type: 'message.relayed', data: { receiptId: RECEIPT } })).toBeNull()
    expect(readReceiptId({ type: 'email.received', data: { receiptId: 'not-a-uuid' } })).toBeNull()
  })

  it('acks a hydrated body and never marks unknown', async () => {
    const ev = events()
    const port = createBodyPhasePort({ events: ev, hydrate: vi.fn().mockResolvedValue({ bodyReady: true }) })
    const outcome = await port(actor)
    expect(outcome.status).toBe('completed')
    expect(ev.ack).toHaveBeenCalledTimes(1)
    expect(ev.fail).not.toHaveBeenCalled()
    expect(ev.markUnknown).not.toHaveBeenCalled()
  })

  it('keeps a not-ready body eligible through an explicit retryable failure', async () => {
    const ev = events()
    const port = createBodyPhasePort({
      events: ev,
      hydrate: vi.fn().mockResolvedValue({ bodyReady: false, reason: 'provider_message_unavailable' }),
    })
    const outcome = await port(actor)
    expect(outcome.status).toBe('held')
    expect(outcome.reason).toBe('provider_message_unavailable')
    expect(ev.ack).not.toHaveBeenCalled()
    expect(ev.fail).toHaveBeenCalledWith(expect.objectContaining({ retryable: true, errorCode: 'provider_message_unavailable' }))
    expect(ev.markUnknown).not.toHaveBeenCalled()
  })

  it('blocks a body whose retries are exhausted instead of reporting success', async () => {
    const ev = events({ fail: vi.fn().mockResolvedValue({ result: 'failed', attempts: 5 }) })
    const port = createBodyPhasePort({ events: ev, hydrate: vi.fn().mockResolvedValue({ bodyReady: false, reason: 'provider_message_unavailable' }) })
    const outcome = await port(actor)
    expect(outcome.status).toBe('blocked')
    expect(outcome.reason).toBe('provider_message_unavailable_exhausted')
    expect(ev.ack).not.toHaveBeenCalled()
  })

  it('treats a provider read failure as a retryable pre-effect failure', async () => {
    const ev = events()
    const port = createBodyPhasePort({ events: ev, hydrate: vi.fn().mockRejectedValue(new Error('network')) })
    const outcome = await port(actor)
    expect(outcome.status).toBe('held')
    expect(ev.fail).toHaveBeenCalledWith(expect.objectContaining({ retryable: true }))
    expect(ev.markUnknown).not.toHaveBeenCalled()
  })

  it('is idle when the outbox has no body job', async () => {
    const ev = events({ claim: vi.fn().mockResolvedValue({ result: 'claimed', jobs: [] }) })
    const port = createBodyPhasePort({ events: ev, hydrate: vi.fn() })
    expect(await port(actor)).toEqual({ status: 'idle', reason: 'no_body_job', modelCalls: 0, smtpAttempts: 0 })
  })

  it('never completes a stale or not_found acknowledgement', async () => {
    for (const result of ['stale', 'not_found'] as const) {
      const ev = events({ ack: vi.fn().mockResolvedValue({ result }) })
      const port = createBodyPhasePort({ events: ev, hydrate: vi.fn().mockResolvedValue({ bodyReady: true }) })
      const outcome = await port(actor)
      expect(outcome.status).toBe('held')
      expect(outcome.reason).toBe(`body_ack_${result}`)
      expect(outcome.referenceId).toBe(RECEIPT)
      expect(outcome.referenceFingerprint).toBe('evt-1')
      expect(ev.fail).not.toHaveBeenCalled()
    }
  })

  it('reports a stale failure settlement as an unsettled hold with the reference', async () => {
    const ev = events({ fail: vi.fn().mockResolvedValue({ result: 'stale' }), ack: vi.fn() })
    const port = createBodyPhasePort({
      events: ev,
      hydrate: vi.fn().mockResolvedValue({ bodyReady: false, reason: 'provider_message_unavailable' }),
    })
    const outcome = await port(actor)
    expect(outcome.status).toBe('held')
    expect(outcome.reason).toBe('body_settlement_stale')
    expect(outcome.referenceId).toBe(RECEIPT)
    expect(ev.ack).not.toHaveBeenCalled()
  })

  it('bounds hydration by both the request deadline and the body fencing lease', async () => {
    const hydrate = vi.fn().mockResolvedValue({ bodyReady: true })
    const port = createBodyPhasePort({ events: events(), hydrate })
    const requestDeadline = Date.now() + 29_000
    expect((await port(actor, requestDeadline)).status).toBe('completed')
    const passed = hydrate.mock.calls[0]?.[2] as number
    expect(passed).toBeLessThanOrEqual(requestDeadline)
    // 20s lease minus the 2s safety margin => at most 18s of provider work.
    expect(passed).toBeLessThanOrEqual(Date.now() + 18_000 + 100)
  })

  it('forwards the per-call deadline into claim and ack without changing the lease', async () => {
    const ev = events()
    const port = createBodyPhasePort({ events: ev, hydrate: vi.fn().mockResolvedValue({ bodyReady: true }) })
    const requestDeadline = Date.now() + 29_000
    expect((await port(actor, requestDeadline)).status).toBe('completed')
    const claim = (ev.claim as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { deadlineAt?: number; leaseSeconds: number }
    expect(claim.deadlineAt).toBeLessThanOrEqual(requestDeadline)
    expect(claim.deadlineAt).toBeGreaterThan(0)
    expect(claim.leaseSeconds).toBe(BODY_LEASE_SECONDS)
    expect(ev.ack).toHaveBeenCalledWith(expect.objectContaining({ deadlineAt: claim.deadlineAt }))
  })

  it('forwards the per-call deadline into a retryable failure settlement', async () => {
    const ev = events({ fail: vi.fn().mockResolvedValue({ result: 'retryable' }) })
    const port = createBodyPhasePort({
      events: ev,
      hydrate: vi.fn().mockResolvedValue({ bodyReady: false, reason: 'provider_message_unavailable' }),
    })
    const requestDeadline = Date.now() + 29_000
    await port(actor, requestDeadline)
    const failInput = (ev.fail as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { deadlineAt?: number }
    expect(failInput.deadlineAt).toBeGreaterThan(0)
    expect(failInput.deadlineAt).toBeLessThanOrEqual(requestDeadline)
  })

  it('omits deadline metadata on legacy calls that pass no absolute deadline', async () => {
    const ev = events()
    const port = createBodyPhasePort({ events: ev, hydrate: vi.fn().mockResolvedValue({ bodyReady: true }) })
    await port(actor)
    expect((ev.claim as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).not.toHaveProperty('deadlineAt')
    expect((ev.ack as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).not.toHaveProperty('deadlineAt')
  })
})

describe('phase dispatch mapping', () => {
  it('routes each phase to exactly its own port', async () => {
    const phases = ['campaign', 'body', 'decision', 'reply'] as const
    for (const phase of phases) {
      const p = ports()
      await executeClaimedPhase(p, claimed({ phase }), 10_000)
      const expected = { campaign: 'dispatch', body: 'body', decision: 'decision', reply: 'reply' }[phase]
      for (const name of ['dispatch', 'body', 'decision', 'reply']) {
        const mock = p[name as keyof typeof p] as unknown as ReturnType<typeof vi.fn>
        expect(mock).toHaveBeenCalledTimes(name === expected ? 1 : 0)
      }
    }
  })
})
