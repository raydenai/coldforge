import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, refresh: nav.refresh }),
}))

const fake = vi.hoisted(() => ({ signUp: vi.fn() }))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { signUp: fake.signUp } }),
}))

import RegisterPage from '@/app/(auth)/register/page'

const fakeUser = {
  id: 'user-1',
  email: 'user@example.com',
  aud: 'authenticated',
  role: 'authenticated',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  app_metadata: {},
  user_metadata: {},
}

async function submitRegistration() {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('Full Name'), 'Jane Doe')
  await user.type(screen.getByLabelText('Organization Name'), 'Acme Inc')
  await user.type(screen.getByLabelText('Email'), 'user@example.com')
  await user.type(screen.getByLabelText('Password'), 'password123')
  await user.click(screen.getByRole('button', { name: /create account/i }))
}

beforeEach(() => {
  nav.push.mockReset()
  nav.refresh.mockReset()
  fake.signUp.mockReset()
})

describe('RegisterPage', () => {
  it('sends the retained metadata and a same-origin PKCE email redirect', async () => {
    fake.signUp.mockResolvedValue({
      data: { user: fakeUser, session: { access_token: 'fake' } },
      error: null,
    })

    render(<RegisterPage />)
    await submitRegistration()

    await waitFor(() => expect(fake.signUp).toHaveBeenCalledTimes(1))
    expect(fake.signUp).toHaveBeenCalledWith({
      email: 'user@example.com',
      password: 'password123',
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
        data: {
          full_name: 'Jane Doe',
          organization_name: 'Acme Inc',
        },
      },
    })
  })

  it('routes an immediate session to onboarding', async () => {
    fake.signUp.mockResolvedValue({
      data: { user: fakeUser, session: { access_token: 'fake' } },
      error: null,
    })

    render(<RegisterPage />)
    await submitRegistration()

    await waitFor(() => expect(nav.push).toHaveBeenCalledWith('/onboarding'))
  })

  it('routes a confirmation-required signup to the login verify notice', async () => {
    fake.signUp.mockResolvedValue({
      data: { user: fakeUser, session: null },
      error: null,
    })

    render(<RegisterPage />)
    await submitRegistration()

    await waitFor(() =>
      expect(nav.push).toHaveBeenCalledWith('/login?verify=email')
    )
  })

  it('surfaces a signup error without navigating', async () => {
    fake.signUp.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: 'User already registered' },
    })

    render(<RegisterPage />)
    await submitRegistration()

    await waitFor(() =>
      expect(screen.getByText('User already registered')).toBeInTheDocument()
    )
    expect(nav.push).not.toHaveBeenCalled()
  })
})
