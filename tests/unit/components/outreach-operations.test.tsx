import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { OperationsContent } from '@/app/(dashboard)/operations/operations-content'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function view(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString()
  return {
    status: {
      control: { revision: 4, automationEnabled: true, schedulerPaused: false, masterStop: false, enabledAt: now, updatedAt: now },
      heartbeat: {
        revision: 2,
        lastAttemptAt: now,
        lastAttemptPhase: 'body',
        lastAttemptStatus: 'completed',
        lastAttemptDetail: 'body_ready',
        lastSuccessAt: now,
        consecutiveFailures: 0,
      },
      stats: { attemptsAccepted: 3, attemptsUnknown: 1, attemptsReserved: 0, sendsAcceptedToday: 3, agentRunsUnknown: 0, bodyPending: 2, decisionsPending: 1 },
      attention: [{ kind: 'smtp_unknown', referenceId: 'attempt-1', reason: 'transport_exception', observedAt: now, fingerprint: 'fp' }],
      runs: [
        {
          id: 'run-1',
          phase: 'body',
          status: 'completed',
          reason: 'body_ready',
          campaignId: null,
          referenceId: null,
          referenceFingerprint: null,
          attemptId: null,
          decisionId: null,
          modelCalls: 0,
          smtpAttempts: 0,
          startedAt: now,
          settledAt: now,
        },
      ],
      ...((overrides.status as Record<string, unknown>) ?? {}),
    },
    readiness: overrides.readiness ?? { ready: true, activeCampaigns: 1, configuredCampaigns: 1, blockers: [] },
  }
}

it('shows real recorded metrics and the attention reference', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(view())))
  render(<OperationsContent />)
  expect(await screen.findByText('SMTP accepted today: 3')).toBeInTheDocument()
  expect(screen.getByText('attempt-1')).toBeInTheDocument()
  expect(screen.getByText('Unconfirmed email')).toBeInTheDocument()
  expect(screen.getByText('Bodies pending: 2')).toBeInTheDocument()
})

it('renders unavailability on a failed read instead of fabricated zeros', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { message: 'Automation read unavailable' } }, { status: 503 })))
  render(<OperationsContent />)
  expect(await screen.findByText('Operations unavailable')).toBeInTheDocument()
  expect(screen.getByText('Automation read unavailable')).toBeInTheDocument()
  expect(screen.queryByText(/SMTP accepted today/)).not.toBeInTheDocument()
})

it('locks the control so a double click posts only once', async () => {
  let release: (response: Response) => void = () => {}
  const pending = new Promise<Response>((resolve) => {
    release = resolve
  })
  const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
    init?.method === 'POST' ? pending : Promise.resolve(Response.json(view({ status: { control: { revision: 4, automationEnabled: false, schedulerPaused: false, masterStop: false, enabledAt: null, updatedAt: null } } }))),
  )
  vi.stubGlobal('fetch', fetchMock)
  render(<OperationsContent />)
  const button = await screen.findByRole('button', { name: 'Enable automation' })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
  release(Response.json({ control: { revision: 5, automationEnabled: true, schedulerPaused: false, masterStop: false } }))
  await waitFor(() => expect(button).not.toBeDisabled())
})

it('surfaces a stale-revision conflict and reloads', async () => {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json({ error: { message: 'Automation state changed; reload before retrying' } }, { status: 409 })
    return Response.json(view())
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<OperationsContent />)
  fireEvent.click(await screen.findByRole('button', { name: 'Pause scheduler' }))
  expect(await screen.findByText('Automation state changed; reload before retrying')).toBeInTheDocument()
  await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => !init?.method || init.method === 'GET')).toHaveLength(2))
})

it('renders readiness blockers with their setup destination', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(view({ status: { control: { revision: 4, automationEnabled: false, schedulerPaused: false, masterStop: false, enabledAt: null, updatedAt: null } }, readiness: { ready: false, activeCampaigns: 0, configuredCampaigns: 0, blockers: [{ code: 'winnr_connection', label: 'Connect Winnr', href: '/winnr' }] } }))))
  render(<OperationsContent />)
  expect(await screen.findByText('Connect Winnr')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', '/winnr')
  expect(screen.getByRole('button', { name: 'Enable automation' })).toBeDisabled()
})

it('labels scheduler pause and the master stop separately', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(view({ status: { control: { revision: 4, automationEnabled: true, schedulerPaused: true, masterStop: true, enabledAt: null, updatedAt: null } } }))))
  render(<OperationsContent />)
  expect(await screen.findByText('Scheduler paused')).toBeInTheDocument()
  expect(screen.getByText('Master outbound stop ON')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Resume scheduler/ })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Resume outbound/ })).toBeInTheDocument()
})
