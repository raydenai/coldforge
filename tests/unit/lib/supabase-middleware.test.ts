import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const state = vi.hoisted(() => ({
  user: null as { id: string } | null,
  cookiesToSet: [] as Array<{
    name: string
    value: string
    options?: Record<string, unknown>
  }>,
}))

vi.mock('@supabase/ssr', () => ({
  createServerClient: (
    _url: string,
    _key: string,
    options: { cookies: { setAll: (cookies: unknown[]) => void } }
  ) => {
    options.cookies.setAll(state.cookiesToSet)
    return {
      auth: {
        getUser: async () => ({ data: { user: state.user }, error: null }),
      },
    }
  },
}))

import { updateSession } from '@/lib/supabase/middleware'

function request(path: string) {
  return new NextRequest(`https://app.example${path}`)
}

beforeEach(() => {
  state.user = null
  state.cookiesToSet = []
})

describe('session-refresh middleware', () => {
  it.each(['/operations', '/agents', '/pipeline', '/analytics'])(
    'protects retained app path %s for anonymous visitors',
    async (path) => {
      const response = await updateSession(request(path))
      const location = new URL(response.headers.get('location')!)

      expect(location.pathname).toBe('/login')
      expect(location.searchParams.get('redirect')).toBe(path)
    }
  )

  it('preserves a refreshed session cookie when redirecting an anonymous visitor', async () => {
    state.cookiesToSet = [
      { name: 'sb-refreshed', value: 'rotated-token', options: { path: '/' } },
    ]

    const response = await updateSession(request('/operations'))

    expect(response.headers.get('location')).toContain('/login')
    expect(response.cookies.get('sb-refreshed')?.value).toBe('rotated-token')
  })

  it('preserves the refreshed session cookie on authenticated auth-route redirects', async () => {
    state.user = { id: 'user-1' }
    state.cookiesToSet = [
      { name: 'sb-refreshed', value: 'rotated-token', options: { path: '/' } },
    ]

    const response = await updateSession(request('/login'))
    const location = new URL(response.headers.get('location')!)

    expect(location.pathname).toBe('/operations')
    expect(response.cookies.get('sb-refreshed')?.value).toBe('rotated-token')
  })

  it('lets public paths through while still persisting refreshed cookies', async () => {
    state.user = { id: 'user-1' }
    state.cookiesToSet = [
      { name: 'sb-refreshed', value: 'rotated-token', options: { path: '/' } },
    ]

    const response = await updateSession(request('/onboarding'))

    expect(response.headers.get('location')).toBeNull()
    expect(response.cookies.get('sb-refreshed')?.value).toBe('rotated-token')
  })

  it('does not redirect anonymous visitors away from public paths', async () => {
    const response = await updateSession(request('/login'))

    expect(response.headers.get('location')).toBeNull()
  })
})
