import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const boundary = vi.hoisted(() => ({
  createClient: vi.fn(),
  exchangeCodeForSession: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => boundary.createClient(),
}))

import { GET } from '@/app/auth/callback/route'

function callbackRequest(query: string) {
  return new NextRequest(`https://app.example/auth/callback${query}`)
}

function locationOf(response: Response): URL {
  return new URL(response.headers.get('location')!)
}

beforeEach(() => {
  vi.clearAllMocks()
  boundary.createClient.mockReturnValue({
    auth: { exchangeCodeForSession: boundary.exchangeCodeForSession },
  })
})

describe('email confirmation callback', () => {
  it('exchanges the code through the server cookie client and lands on the requested path', async () => {
    boundary.exchangeCodeForSession.mockResolvedValue({
      data: { session: { access_token: 'fake' } },
      error: null,
    })

    const response = await GET(callbackRequest('?code=valid-code&next=/settings'))

    expect(response.status).toBe(307)
    expect(boundary.createClient).toHaveBeenCalledTimes(1)
    expect(boundary.exchangeCodeForSession).toHaveBeenCalledWith('valid-code')
    expect(locationOf(response).origin).toBe('https://app.example')
    expect(locationOf(response).pathname).toBe('/settings')
  })

  it('defaults to onboarding when no next is supplied', async () => {
    boundary.exchangeCodeForSession.mockResolvedValue({
      data: { session: { access_token: 'fake' } },
      error: null,
    })

    const response = await GET(callbackRequest('?code=valid-code'))

    expect(locationOf(response).pathname).toBe('/onboarding')
  })

  it.each([
    ['https://evil.example', 'external absolute'],
    ['//evil.example', 'protocol-relative'],
    ['/login', 'auth loop'],
  ])('rejects %s (%s) and uses the onboarding fallback', async (next) => {
    boundary.exchangeCodeForSession.mockResolvedValue({
      data: { session: { access_token: 'fake' } },
      error: null,
    })

    const response = await GET(
      callbackRequest(`?code=valid-code&next=${encodeURIComponent(next)}`)
    )

    expect(locationOf(response).origin).toBe('https://app.example')
    expect(locationOf(response).pathname).toBe('/onboarding')
  })

  it('routes an invalid or expired code to login without leaking the code or raw error', async () => {
    boundary.exchangeCodeForSession.mockResolvedValue({
      data: { session: null },
      error: { message: 'invalid request: both auth code and code verifier should be non-empty' },
    })

    const response = await GET(callbackRequest('?code=secret-auth-code'))
    const location = locationOf(response)

    expect(location.pathname).toBe('/login')
    expect(location.searchParams.get('error')).toBe('confirm')
    expect(location.searchParams.get('redirect')).toBe('/onboarding')
    expect(location.href).not.toContain('secret-auth-code')
    expect(location.href).not.toContain('code verifier')
  })

  it('handles a missing code (cross-browser PKCE link) without calling exchange and without a false success', async () => {
    const response = await GET(callbackRequest('?next=/settings'))
    const location = locationOf(response)

    expect(boundary.exchangeCodeForSession).not.toHaveBeenCalled()
    expect(location.pathname).toBe('/login')
    expect(location.searchParams.get('error')).toBe('confirm')
    expect(location.searchParams.get('redirect')).toBe('/settings')
  })
})
