import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const nav = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  searchParams: new URLSearchParams(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, refresh: nav.refresh }),
  useSearchParams: () => nav.searchParams,
}))

const fake = vi.hoisted(() => ({ signInWithPassword: vi.fn() }))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { signInWithPassword: fake.signInWithPassword },
  }),
}))

import LoginForm from '@/app/(auth)/login/login-form'

async function submitCredentials() {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('Email'), 'user@example.com')
  await user.type(screen.getByLabelText('Password'), 'password123')
  await user.click(screen.getByRole('button', { name: /sign in/i }))
}

beforeEach(() => {
  nav.push.mockReset()
  nav.refresh.mockReset()
  nav.searchParams = new URLSearchParams()
  fake.signInWithPassword.mockReset()
  fake.signInWithPassword.mockResolvedValue({ data: {}, error: null })
})

describe('LoginForm confirmation guidance', () => {
  it('renders the verify=email confirmation notice', () => {
    nav.searchParams = new URLSearchParams('verify=email')

    render(<LoginForm />)

    expect(screen.getByRole('status')).toHaveTextContent(/confirmation link/i)
  })

  it('renders clear sign-in guidance after a failed confirmation callback without raw errors', () => {
    nav.searchParams = new URLSearchParams(
      'error=confirm&redirect=/onboarding&code=secret-auth-code'
    )

    render(<LoginForm />)

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(/couldn't finish sign-in/i)
    expect(alert).toHaveTextContent(/different browser/i)
    expect(alert).not.toHaveTextContent(/secret-auth-code/)
    expect(alert).not.toHaveTextContent(/code verifier/i)
  })
})

describe('LoginForm post-auth destination', () => {
  it('uses an allowed same-origin redirect', async () => {
    nav.searchParams = new URLSearchParams('redirect=/settings')

    render(<LoginForm />)
    await submitCredentials()

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/settings'))
  })

  it('defaults to the current app entry when no redirect is supplied', async () => {
    render(<LoginForm />)
    await submitCredentials()

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/operations'))
  })

  it.each([
    ['https://evil.example', 'absolute external'],
    ['//evil.example', 'protocol-relative external'],
    ['/login', 'auth loop'],
    ['/auth/callback?code=abc', 'callback loop'],
  ])('rejects %s (%s) and falls back to the app entry', async (redirect) => {
    nav.searchParams = new URLSearchParams(`redirect=${encodeURIComponent(redirect)}`)

    render(<LoginForm />)
    await submitCredentials()

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/operations'))
  })
})
