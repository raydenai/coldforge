import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import { createServiceRoleRepository, getServiceRoleConfig, type WinnrDatabase } from '@/lib/winnr/database'

afterEach(() => vi.unstubAllEnvs())

describe('Winnr real Supabase adapter with fake HTTP', () => {
  it('sends the typed reservation RPC with its client context intact', async () => {
    const fetch = vi.fn(async () => Response.json({ result: 'reserved' }))
    const client = createClient<WinnrDatabase>('https://fixture.supabase.co', 'fixture-service-key', {
      global: { fetch }, auth: { persistSession: false, autoRefreshToken: false },
    })
    const repository = createServiceRoleRepository({ client })
    await expect(repository.reserveOperation({
      organizationId: 'org-fixture', operationId: 'op-fixture', connectionId: 'conn-fixture',
      connectionVersion: 1, action: 'enable', mailboxIds: ['mb-fixture'], fingerprint: 'hash-fixture',
    })).resolves.toEqual({ result: 'reserved' })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(fetch.mock.calls[0]?.[0])).toContain('/rest/v1/rpc/winnr_reserve_operation')
  })

  it('fails without a service-role key even when an anon key exists', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fixture.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'fixture-anon-key')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
    expect(getServiceRoleConfig).toThrow('Winnr storage is not configured')
  })
})
