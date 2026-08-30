import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * These tests pin the reply-vs-campaign policy split, which is a deliberate
 * judgment call rather than a mechanical rule. If someone widens or narrows
 * REPLY_BLOCKING_REASONS, these should fail and force the decision to be
 * re-made consciously.
 */

const selectChain = {
  select: vi.fn().mockReturnThis(),
  eq: vi.fn().mockReturnThis(),
  or: vi.fn().mockReturnThis(),
  limit: vi.fn(),
}

const mockFrom = vi.fn(() => selectChain)

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: mockFrom }),
}))

/** Make the suppression lookup return a specific row (or none). */
function whenSuppression(row: { reason: string; expires_at: string | null } | null) {
  selectChain.limit.mockResolvedValue({ data: row ? [row] : [], error: null })
}

function whenLookupErrors() {
  selectChain.limit.mockResolvedValue({ data: null, error: { code: 'PGRST500' } })
}

beforeEach(() => {
  vi.clearAllMocks()
  selectChain.select.mockReturnThis()
  selectChain.eq.mockReturnThis()
  selectChain.or.mockReturnThis()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isSuppressed (campaign gate)', () => {
  it('allows an address with no suppression row', async () => {
    const { isSuppressed } = await import('@/lib/compliance/suppression')
    whenSuppression(null)

    expect((await isSuppressed('a@example.com', 'ws-1')).eligible).toBe(true)
  })

  it.each([
    'unsubscribe',
    'complaint',
    'hard_bounce',
    'spam_trap',
    'invalid',
    'role_based',
    'manual',
  ])('blocks a campaign send for reason: %s', async (reason) => {
    const { isSuppressed } = await import('@/lib/compliance/suppression')
    whenSuppression({ reason, expires_at: null })

    const result = await isSuppressed('a@example.com', 'ws-1')
    expect(result.eligible).toBe(false)
    expect(result.reason).toBe(reason)
  })

  // A suppression lookup that errors must never read as "not suppressed".
  it('fails closed when the lookup errors', async () => {
    const { isSuppressed } = await import('@/lib/compliance/suppression')
    whenLookupErrors()

    const result = await isSuppressed('a@example.com', 'ws-1')
    expect(result.eligible).toBe(false)
    expect(result.reason).toBe('error')
  })
})

describe('canReplyToInbound (reply gate)', () => {
  it('allows a reply when nothing is suppressed', async () => {
    const { canReplyToInbound } = await import('@/lib/compliance/suppression')
    whenSuppression(null)

    expect((await canReplyToInbound('a@example.com', 'ws-1')).eligible).toBe(true)
  })

  // The policy decision: an opt-out withdraws consent for commercial mail, not
  // for answering a message the person sent us.
  it('ALLOWS replying to someone who unsubscribed', async () => {
    const { canReplyToInbound } = await import('@/lib/compliance/suppression')
    whenSuppression({ reason: 'unsubscribe', expires_at: null })

    expect((await canReplyToInbound('a@example.com', 'ws-1')).eligible).toBe(true)
  })

  it.each(['complaint', 'spam_trap', 'hard_bounce', 'invalid'])(
    'BLOCKS replying when reason is: %s',
    async (reason) => {
      const { canReplyToInbound } = await import('@/lib/compliance/suppression')
      whenSuppression({ reason, expires_at: null })

      const result = await canReplyToInbound('a@example.com', 'ws-1')
      expect(result.eligible).toBe(false)
      expect(result.reason).toBe(reason)
    }
  )

  it.each(['role_based', 'manual', 'soft_bounce'])(
    'allows replying for targeting-only reason: %s',
    async (reason) => {
      const { canReplyToInbound } = await import('@/lib/compliance/suppression')
      whenSuppression({ reason, expires_at: null })

      expect((await canReplyToInbound('a@example.com', 'ws-1')).eligible).toBe(true)
    }
  )

  it('fails closed when the lookup errors', async () => {
    const { canReplyToInbound } = await import('@/lib/compliance/suppression')
    whenLookupErrors()

    const result = await canReplyToInbound('a@example.com', 'ws-1')
    expect(result.eligible).toBe(false)
    expect(result.reason).toBe('error')
  })
})

describe('isPermanentReason', () => {
  it('treats soft_bounce as temporary', async () => {
    const { isPermanentReason } = await import('@/lib/compliance/suppression')
    expect(isPermanentReason('soft_bounce')).toBe(false)
  })

  it.each(['hard_bounce', 'complaint', 'unsubscribe', 'spam_trap'] as const)(
    'treats %s as permanent',
    async (reason) => {
      const { isPermanentReason } = await import('@/lib/compliance/suppression')
      expect(isPermanentReason(reason)).toBe(true)
    }
  )
})
