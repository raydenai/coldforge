import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const db = vi.hoisted(() => ({
  user: vi.fn(),
  from: vi.fn(),
  adminFrom: vi.fn(),
  capturedUpdate: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: db.user }, from: db.from }),
}))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: db.adminFrom }),
}))
vi.mock('@/lib/cache/queries', () => ({ invalidateLeadsCache: vi.fn() }))

import { POST } from '@/app/api/leads/import/route'

const ORG = '11111111-1111-4111-8111-111111111111'
const ORIGIN = 'https://import.example'

function request(body: unknown) {
  return new NextRequest(`${ORIGIN}/api/leads/import`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function existingLeadChain() {
  const single = async () => ({ data: { id: 'lead-1' }, error: null })
  const secondEq = () => ({ single })
  return { select: () => ({ eq: () => ({ eq: secondEq }) }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  db.user.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null })
  db.from.mockImplementation((table: string) => {
    if (table === 'users') {
      return { select: () => ({ eq: () => ({ single: async () => ({ data: { organization_id: ORG }, error: null }) }) }) }
    }
    if (table === 'leads') return existingLeadChain()
    if (table === 'lead_lists') {
      return { select: () => ({ eq: () => ({ eq: () => ({ single: async () => ({ data: { id: 'list-1' }, error: null }) }) }) }) }
    }
    return {}
  })
  db.adminFrom.mockImplementation(() => ({
    update: (payload: unknown) => {
      db.capturedUpdate(payload)
      return { eq: async () => ({ error: null }) }
    },
  }))
})

async function updateBody(leads: unknown[]) {
  const response = await POST(request({ leads, updateExisting: true }))
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ success: true, updated: 1 })
  return db.capturedUpdate.mock.calls[0][0] as Record<string, unknown>
}

describe('lead import updateExisting preserves omitted fields', () => {
  it('writes only the revision when the request supplies only an email', async () => {
    const update = await updateBody([{ email: 'existing@example.com' }])
    expect(Object.keys(update).sort()).toEqual(['updated_at'])
    expect(update).not.toHaveProperty('first_name')
    expect(update).not.toHaveProperty('custom_fields')
    expect(update).not.toHaveProperty('list_id')
  })

  it('writes only explicitly supplied enrichment fields', async () => {
    const update = await updateBody([{ email: 'existing@example.com', firstName: 'Ada' }])
    expect(update.first_name).toBe('Ada')
    expect(Object.keys(update).sort()).toEqual(['first_name', 'updated_at'])
    expect(update).not.toHaveProperty('last_name')
    expect(update).not.toHaveProperty('company')
  })

  it('clears a field only when it is explicitly supplied empty', async () => {
    const update = await updateBody([{ email: 'existing@example.com', company: '' }])
    expect(update).toHaveProperty('company', null)
  })

  it('persists explicitly supplied custom metadata and ignores non-string values', async () => {
    const update = await updateBody([{
      email: 'existing@example.com',
      customFields: { source: 'csv' },
      phone: 42,
    }])
    expect(update.custom_fields).toEqual({ source: 'csv' })
    expect(update).not.toHaveProperty('phone')
  })
})
