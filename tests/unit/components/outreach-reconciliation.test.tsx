import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReconciliationDashboard } from '@/app/(dashboard)/operations/reconciliation/reconciliation-dashboard'

const available = '33333333-3333-4333-8333-333333333333'
const missing = '44444444-4444-4444-8444-444444444444'
const conflicting = '55555555-5555-4555-8555-555555555555'

function item(attemptId: string, evidence: 'available' | 'missing' | 'conflicting') {
  return {
    attemptId,
    kind: 'campaign' as const,
    status: 'unknown',
    createdAt: '2026-10-05T00:00:00.000Z',
    authorizedAt: '2026-10-05T00:00:01.000Z',
    ageSeconds: 600,
    recipient: 'lead@example.test',
    sender: 'sender@example.test',
    campaignId: '66666666-6666-4666-8666-666666666666',
    threadId: null,
    sourceReplyId: null,
    fingerprint: 'a'.repeat(64),
    evidence,
    providerMessageId: evidence === 'available' ? '<relayed@example.test>' : null,
  }
}

function listBody(items = [item(available, 'available'), item(missing, 'missing'), item(conflicting, 'conflicting')]) {
  return {
    items,
    counts: { unconfirmed: items.length, accepted: 4, held: items.length, available: 1, conflicting: 1, missing: 1 },
    recent: [],
    generatedAt: '2026-10-05T00:05:00.000Z',
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('reconciliation dashboard', () => {
  it('shows unavailable instead of fake zero measurements when the read fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down')
    }))
    render(<ReconciliationDashboard />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/unavailable/i)
    expect(screen.getByTestId('counts-accepted')).toHaveTextContent('—')
    expect(screen.getByTestId('counts-unconfirmed')).toHaveTextContent('—')
    expect(screen.getByTestId('counts-available')).toHaveTextContent('—')
  })

  it('labels available, missing and conflicting evidence and only enables reconcile for available', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(listBody())))
    render(<ReconciliationDashboard />)
    await screen.findByTestId(`held-${available}`)
    expect(screen.getByText('Relay evidence available')).toBeInTheDocument()
    expect(screen.getAllByText('No relay evidence').length).toBeGreaterThan(0)
    expect(screen.getByText('Conflicting relay evidence')).toBeInTheDocument()
    const buttons = screen.getAllByRole('button', { name: /^reconcile$/i })
    expect(buttons).toHaveLength(3)
    expect(buttons.filter((button) => !button.hasAttribute('disabled'))).toHaveLength(1)
    expect(buttons[0]).toBeEnabled()
    expect(buttons[1]).toBeDisabled()
    expect(screen.getByTestId(`guidance-${missing}`)).toHaveTextContent(/Winnr webhook association/i)
    expect(screen.getByTestId(`guidance-${missing}`)).toHaveTextContent(/manual inbox sync/i)
    expect(screen.queryByRole('button', { name: /resend/i })).toBeNull()
  })

  it('locks a pending reconcile so a double click records at most one effect', async () => {
    const resolvers: Array<(value: Response) => void> = []
    const fetchMock = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return new Promise<Response>((resolve) => resolvers.push(resolve))
      return Promise.resolve(Response.json(listBody([item(available, 'available')])))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ReconciliationDashboard />)
    const button = await screen.findByRole('button', { name: /^reconcile$/i })
    fireEvent.click(button)
    fireEvent.click(button)
    await waitFor(() => expect(fetchMock.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === 'POST')).toHaveLength(1))
    expect(button).toBeDisabled()
    expect(button).toHaveTextContent(/Reconciling/i)
    resolvers[0](Response.json({ status: 'held', reason: 'evidence_missing', attemptId: available }))
    expect(await screen.findByRole('status')).toHaveTextContent(/Do not resend/i)
  })

  it('reports an idempotent accepted result without claiming a new send', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return Response.json({ status: 'accepted', alreadyAccepted: true, attemptId: available })
      return Response.json(listBody([item(available, 'available')]))
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<ReconciliationDashboard />)
    fireEvent.click(await screen.findByRole('button', { name: /^reconcile$/i }))
    expect(await screen.findByRole('status')).toHaveTextContent(/Already recorded as accepted/i)
    expect(await screen.findByRole('status')).not.toHaveTextContent(/sent/i)
  })

  it('offers setup backlinks and never renders raw message content', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(listBody)))
    render(<ReconciliationDashboard />)
    await screen.findByTestId('reconciliation-dashboard')
    expect(screen.getByRole('link', { name: /Winnr connections and ingestion/i })).toHaveAttribute('href', '/winnr')
    expect(screen.getByRole('link', { name: /Inbox manual sync/i })).toHaveAttribute('href', '/inbox')
    expect(screen.queryByText(/body_text|api[_-]?key|ciphertext/i)).toBeNull()
  })
})
