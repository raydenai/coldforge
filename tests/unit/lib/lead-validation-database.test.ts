/**
 * Repository boundary tests: an evidence read failure must surface as an error
 * instead of being silently downgraded to "no evidence", and the provider
 * finalize call must carry the server receive time and provider reference.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const boundary = vi.hoisted(() => ({ db: null as unknown }))

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => boundary.db }))

import { createValidationRepository, ValidationRepositoryError } from '@/lib/outreach/validation-database'

const org = '11111111-1111-4111-8111-111111111111'

/** Minimal thenable chain mirroring a Supabase PostgREST builder. */
function query(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  const proxy: Record<string, unknown> = new Proxy(chain, {
    get: (_target, property) => {
      if (property === 'then') return (resolve: (value: unknown) => void) => resolve(result)
      return () => proxy
    },
  })
  return proxy
}

beforeEach(() => {
  boundary.db = {
    from: vi.fn(),
    rpc: vi.fn(),
  }
})

describe('validation repository boundaries', () => {
  it('surfaces an evidence read error instead of treating it as unverified legacy', async () => {
    const db = boundary.db as { from: ReturnType<typeof vi.fn> }
    db.from.mockImplementation((table: string) =>
      table === 'leads'
        ? query({ data: [{ id: 'lead-1', email: 'person@example.com', status: 'active', validation_status: 'valid' }], error: null })
        : query({ data: null, error: { message: 'connection reset' } })
    )
    await expect(createValidationRepository().listLeads(org)).rejects.toBeInstanceOf(ValidationRepositoryError)
  })

  it('maps outstanding reserved/held_unknown operations for the UI to resume', async () => {
    const db = boundary.db as { from: ReturnType<typeof vi.fn> }
    db.from.mockImplementation((table: string) => {
      if (table !== 'lead_validation_operations') throw new Error('unexpected table')
      return query({
        data: [
          { id: 'op-1', lead_id: 'lead-1', email: 'person@example.com', state: 'reserved', validation_status: null },
          { id: 'op-2', lead_id: 'lead-2', email: 'other@example.com', state: 'held_unknown', validation_status: 'unknown' },
        ],
        error: null,
      })
    })
    const outstanding = await createValidationRepository().listOutstandingOperations(org)
    expect(outstanding).toEqual([
      { operationId: 'op-1', leadId: 'lead-1', email: 'person@example.com', state: 'reserved', validationStatus: null },
      { operationId: 'op-2', leadId: 'lead-2', email: 'other@example.com', state: 'held_unknown', validationStatus: 'unknown' },
    ])
  })

  it('passes the server checked-at and parsed provider reference to finalize', async () => {
    const db = boundary.db as { rpc: ReturnType<typeof vi.fn> }
    db.rpc.mockResolvedValue({
      data: { operationId: 'op-1', email: 'person@example.com', state: 'completed', validationStatus: 'valid', replayed: false },
      error: null,
    })
    await createValidationRepository().finalizeProvider({
      operationId: 'op-1',
      actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      organizationId: org,
      leadId: 'lead-1',
      providerEmail: 'person@example.com',
      providerStatus: 'valid',
      substatus: null,
      reference: '2026-10-05T12:00:00.000Z',
      checkedAt: '2026-10-06T01:00:00.000Z',
    })
    expect(db.rpc).toHaveBeenCalledWith(
      'lead_validation_finalize_provider',
      expect.objectContaining({
        p_reference: '2026-10-05T12:00:00.000Z',
        p_checked_at: '2026-10-06T01:00:00.000Z',
        p_provider_email: 'person@example.com',
      })
    )
  })

  it('maps an unresolved-operation RPC failure to a typed repository error', async () => {
    const db = boundary.db as { rpc: ReturnType<typeof vi.fn> }
    db.rpc.mockResolvedValue({ data: null, error: { message: 'lead_validation:unresolved_operation' } })
    await expect(
      createValidationRepository().reserveOperation({
        operationId: 'op-1',
        actorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        organizationId: org,
        leadId: 'lead-1',
        source: 'zerobounce',
      })
    ).rejects.toMatchObject({ code: 'lead_validation:unresolved_operation' })
  })
})
