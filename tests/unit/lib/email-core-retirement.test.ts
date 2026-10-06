import { afterEach, describe, expect, it, vi } from 'vitest'
import { redirect } from 'next/navigation'
import AccountsPage from '@/app/(dashboard)/accounts/page'
import DomainsPage from '@/app/(dashboard)/domains/page'
import WarmupPage from '@/app/(dashboard)/warmup/page'
import { createAdminClient } from '@/lib/supabase/admin'

afterEach(() => vi.unstubAllEnvs())
describe('email infrastructure ownership', () => {
  it.each([AccountsPage, DomainsPage, WarmupPage])('redirects a legacy infrastructure page to Winnr', Page => {
    Page()
    expect(redirect).toHaveBeenCalledWith('/winnr')
  })
  it('refuses privileged storage without a service-role credential', () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', undefined)
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://fixture.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'fixture-anon-key')
    expect(() => createAdminClient()).toThrow(/service.role/i)
  })
})
