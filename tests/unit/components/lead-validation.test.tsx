import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ValidationContent } from '@/app/(dashboard)/leads/validation/validation-content'

afterEach(() => {
  cleanup()
  window.sessionStorage.clear()
  vi.unstubAllGlobals()
})

function listResponse(overrides: Record<string, unknown> = {}) {
  return Response.json({
    provider: { name: 'zerobounce', configured: true },
    leads: [
      {
        id: 'lead-1',
        email: 'unknown@example.com',
        status: 'active',
        validationStatus: 'unknown',
        measured: false,
        provenance: {
          leadId: 'lead-1',
          validationStatus: 'unknown',
          substatus: 'timeout',
          verificationLevel: 'unverified_unknown',
          source: 'zerobounce',
          reference: null,
          checkedAt: '2026-10-05T12:00:00.000Z',
          operationId: 'op-1',
          attested: false,
        },
      },
      {
        id: 'lead-2',
        email: 'valid@example.com',
        status: 'active',
        validationStatus: 'valid',
        measured: true,
        provenance: {
          leadId: 'lead-2',
          validationStatus: 'valid',
          substatus: null,
          verificationLevel: 'verified_provider',
          source: 'zerobounce',
          reference: '2026-10-05T12:00:00.000Z',
          checkedAt: '2026-10-05T12:00:00.000Z',
          operationId: 'op-2',
          attested: false,
        },
      },
    ],
    summary: { total: 2, measured: 1, explicitUnknown: 1, unchecked: 0, valid: 1, invalid: 0, risky: 0 },
    ...overrides,
  })
}

describe('lead validation page states', () => {
  it.each([true, false])('reuses an outstanding operation only for the current address (same address: %s)', async (sameAddress) => {
    const pendingId = '11111111-1111-4111-8111-111111111111'
    const calls: Array<{ leadId: string; operationId: string }> = []
    window.sessionStorage.setItem('lead-validation:selected-lead', 'lead-1')
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/provider')) {
        calls.push(JSON.parse(String(init?.body)))
        return Response.json({ result: { operationId: calls.at(-1)?.operationId, state: 'held_unknown', validationStatus: 'unknown' } })
      }
      return listResponse({ outstanding: [{ operationId: pendingId, leadId: 'lead-1', email: sameAddress ? 'unknown@example.com' : 'old@example.com', state: 'held_unknown' }] })
    }))
    render(<ValidationContent />)
    await waitFor(() => expect(screen.getByRole('button', { name: /Validate with ZeroBounce/i })).toBeEnabled())
    fireEvent.click(screen.getByRole('button', { name: /Validate with ZeroBounce/i }))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0]?.operationId === pendingId).toBe(sameAddress)
    await waitFor(() => expect(screen.getByRole('button', { name: /Validate with ZeroBounce/i })).toBeEnabled())
    fireEvent.change(screen.getByLabelText('Lead'), { target: { value: 'lead-2' } })
    fireEvent.change(screen.getByLabelText('Lead'), { target: { value: 'lead-1' } })
    fireEvent.click(screen.getByRole('button', { name: /Validate with ZeroBounce/i }))
    await waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1]?.operationId === pendingId).toBe(sameAddress)
    await waitFor(() => expect(screen.getByRole('button', { name: /Validate with ZeroBounce/i })).toBeEnabled())
  })

  it('distinguishes measured verdicts from explicit unknown and states the policy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => listResponse()))
    render(<ValidationContent />)

    expect(await screen.findByText('Lead validation')).toBeInTheDocument()
    expect(screen.getByText('Measured verdicts')).toBeInTheDocument()
    expect(screen.getByText('Explicitly unknown')).toBeInTheDocument()
    expect(screen.getByText('Never measured')).toBeInTheDocument()
    expect(screen.getByText(/Only a matching provider receipt claims ZeroBounce verification/i)).toBeInTheDocument()
    expect(screen.getByText(/owner-attested imports are tracked separately/i)).toBeInTheDocument()
  })

  it('shows a configuration-missing state and disables provider validation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => listResponse({ provider: { name: 'zerobounce', configured: false } })))
    render(<ValidationContent />)

    expect(await screen.findByText('ZeroBounce is not configured')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Validate with ZeroBounce/i })).toBeDisabled()
  })

  it('shows a retryable error state instead of an empty list on failure', async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: { message: 'Service unavailable' } }, { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<ValidationContent />)

    expect(await screen.findByText('Could not load validation status')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Retry/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })

  it('validates one selected lead with a single operation id', async () => {
    const calls: Array<{ url: string; body?: string }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), body: init?.body ? String(init.body) : undefined })
        if (String(url).endsWith('/provider')) {
          return Response.json({
            result: { operationId: 'op-1', state: 'completed', validationStatus: 'valid', outcome: 'valid', replayed: false },
          })
        }
        return listResponse()
      })
    )
    render(<ValidationContent />)

    const select = await screen.findByLabelText('Lead')
    fireEvent.change(select, { target: { value: 'lead-1' } })
    fireEvent.click(screen.getByRole('button', { name: /Validate with ZeroBounce/i }))

    await waitFor(() => expect(calls.some((call) => call.url.endsWith('/provider'))).toBe(true))
    const providerCalls = calls.filter((call) => call.url.endsWith('/provider'))
    expect(providerCalls).toHaveLength(1)
    const body = JSON.parse(providerCalls[0]!.body!) as { leadId: string; operationId: string }
    expect(body.leadId).toBe('lead-1')
    expect(body.operationId).toMatch(/^[0-9a-f-]{36}$/)
  })
})
