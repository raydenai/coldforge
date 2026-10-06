import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { CampaignLeads } from '@/app/(dashboard)/campaigns/[id]/campaign-leads'
import { LeadsContent } from '@/app/(dashboard)/leads/leads-content'

const oldLead = { id: 'old', email: 'old@example.com', firstName: 'Old', status: 'pending', currentStep: 1 }
const newLead = { id: 'new', email: 'new@example.com', firstName: 'New', status: 'pending', currentStep: 1 }

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('campaign lead reads distinguish failure from measured empty', () => {
  it('shows a retryable unverified state instead of an empty audience on 503', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const target = String(url)
      if (target.startsWith('/api/leads/lists')) return Response.json({ lists: [] })
      return Response.json({ error: 'unavailable' }, { status: 503 })
    }))
    render(<CampaignLeads campaignId="campaign-1" />)

    expect(await screen.findByText(/Could not load this campaign/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
    expect(screen.queryByText('No leads in this campaign')).not.toBeInTheDocument()
  })

  it('discards a stale response when the filter changes', async () => {
    let resolveFirst: (response: Response) => void = () => {}
    const firstResponse = new Promise<Response>(resolve => { resolveFirst = resolve })
    let leadCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const target = String(url)
      if (target.startsWith('/api/leads/lists')) return Response.json({ lists: [] })
      leadCalls += 1
      if (leadCalls === 1) return firstResponse
      return Response.json({ leads: [newLead], totalPages: 1 })
    }))

    render(<CampaignLeads campaignId="campaign-1" />)
    fireEvent.change(screen.getByPlaceholderText('Search leads...'), { target: { value: 'alpha' } })

    expect(await screen.findByText('new@example.com')).toBeInTheDocument()
    resolveFirst(Response.json({ leads: [oldLead], totalPages: 1 }))

    await waitFor(() => expect(screen.queryByText('old@example.com')).not.toBeInTheDocument())
    expect(screen.getByText('new@example.com')).toBeInTheDocument()
  })
})

describe('main lead reads distinguish failure from measured empty', () => {
  const activeLead = { id: 'active', email: 'active@example.com', status: 'active', created_at: '2026-10-05T00:00:00Z' }
  const bouncedLead = { id: 'bounced', email: 'bounced@example.com', status: 'bounced', created_at: '2026-10-05T00:00:00Z' }

  function listsOk() {
    return Response.json({ lists: [] })
  }

  it('shows a retryable unverified state instead of "No leads yet" on 503', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url)
      if (target === '/api/leads/lists') return listsOk()
      return Response.json({ error: 'unavailable' }, { status: 503 })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<LeadsContent />)

    expect(await screen.findByText(/Couldn.t load leads/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
    expect(screen.queryByText('No leads yet')).not.toBeInTheDocument()
  })

  it('renders Unknown counts and tab on an initial leads 503, never a measured zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const target = String(url)
      if (target === '/api/leads/lists') return listsOk()
      return Response.json({ error: 'unavailable' }, { status: 503 })
    }))
    render(<LeadsContent />)

    expect(await screen.findByText(/Couldn.t load leads/i)).toBeInTheDocument()
    expect(screen.getByTestId('total-leads-count')).toHaveTextContent('Unknown')
    expect(screen.getByTestId('active-leads-count')).toHaveTextContent('Unknown')
    expect(screen.getByTestId('bounced-leads-count')).toHaveTextContent('Unknown')
    expect(screen.getByTestId('all-leads-tab')).toHaveTextContent('All Leads (Unknown)')
    expect(screen.getByTestId('total-leads-count')).not.toHaveTextContent('0')
    // Lists resolved independently and successfully measure empty.
    await waitFor(() => expect(screen.getByTestId('lists-count')).toHaveTextContent('0'))
  })

  it('keeps leads counts measured while lists alone fail', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const target = String(url)
      if (target === '/api/leads/lists') return Response.json({ error: 'unavailable' }, { status: 503 })
      return Response.json({ leads: [activeLead], pagination: { page: 1, limit: 50, total: 1, totalPages: 1 } })
    }))
    render(<LeadsContent />)

    expect(await screen.findByText('active@example.com')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('lists-count')).toHaveTextContent('Unknown'))
    expect(screen.getByTestId('total-leads-count')).toHaveTextContent('1')
    expect(screen.getByText(/Could not load lists/i)).toBeInTheDocument()
    expect(screen.getByTestId('all-leads-tab')).toHaveTextContent('All Leads (1)')
  })

  it('shows measured zero after a successful empty read', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const target = String(url)
      if (target === '/api/leads/lists') return listsOk()
      return Response.json({ leads: [], pagination: { page: 1, limit: 50, total: 0, totalPages: 0 } })
    }))
    render(<LeadsContent />)

    expect(await screen.findByText('No leads yet')).toBeInTheDocument()
    expect(screen.getByTestId('total-leads-count')).toHaveTextContent('0')
    expect(screen.getByTestId('active-leads-count')).toHaveTextContent('0')
    expect(screen.getByTestId('bounced-leads-count')).toHaveTextContent('0')
    expect(screen.getByTestId('lists-count')).toHaveTextContent('0')
    expect(screen.getByTestId('all-leads-tab')).toHaveTextContent('All Leads (0)')
  })

  it('re-reads successfully and restores counts after a retry', async () => {
    let leadCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const target = String(url)
      if (target === '/api/leads/lists') return listsOk()
      leadCalls += 1
      if (leadCalls === 1) return Response.json({ error: 'unavailable' }, { status: 503 })
      return Response.json({ leads: [activeLead, bouncedLead], pagination: { page: 1, limit: 50, total: 2, totalPages: 1 } })
    }))
    render(<LeadsContent />)

    fireEvent.click(await screen.findByRole('button', { name: /retry/i }))
    await waitFor(() => expect(screen.getByTestId('total-leads-count')).toHaveTextContent('2'))
    expect(screen.getByTestId('active-leads-count')).toHaveTextContent('1')
    expect(screen.getByTestId('bounced-leads-count')).toHaveTextContent('1')
    expect(screen.getByTestId('all-leads-tab')).toHaveTextContent('All Leads (2)')
    expect(screen.queryByText(/Couldn.t load leads/i)).not.toBeInTheDocument()
  })

  it('requests and renders the next server page', async () => {
    const requestedPages: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const target = String(url)
      if (target === '/api/leads/lists') return listsOk()
      const parsed = new URL(target, 'https://fixture.example')
      const requestedPage = parsed.searchParams.get('page') || '1'
      requestedPages.push(requestedPage)
      if (requestedPage === '2') {
        return Response.json({ leads: [{ id: 'p2', email: 'page2@example.com', status: 'active', created_at: '2026-10-05T00:00:00Z' }], pagination: { page: 2, limit: 50, total: 2, totalPages: 2 } })
      }
      return Response.json({ leads: [{ id: 'p1', email: 'page1@example.com', status: 'active', created_at: '2026-10-05T00:00:00Z' }], pagination: { page: 1, limit: 50, total: 2, totalPages: 2 } })
    }))
    render(<LeadsContent />)

    expect(await screen.findByText('page1@example.com')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /next page/i }))
    expect(await screen.findByText('page2@example.com')).toBeInTheDocument()
    expect(requestedPages).toContain('2')
    expect(screen.getByText(/Page 2 of 2/)).toBeInTheDocument()
  })

  it('discards an out-of-order filter response', async () => {
    let resolveFirst: (response: Response) => void = () => {}
    const firstResponse = new Promise<Response>(resolve => { resolveFirst = resolve })
    let leadCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const target = String(url)
      if (target === '/api/leads/lists') return listsOk()
      leadCalls += 1
      if (leadCalls === 1) return firstResponse
      return Response.json({ leads: [{ id: 'new', email: 'new@example.com', status: 'active', created_at: '2026-10-05T00:00:00Z' }], pagination: { page: 1, limit: 50, total: 1, totalPages: 1 } })
    }))

    render(<LeadsContent />)
    fireEvent.change(screen.getByPlaceholderText('Search leads...'), { target: { value: 'alpha' } })

    expect(await screen.findByText('new@example.com')).toBeInTheDocument()
    resolveFirst(Response.json({ leads: [{ id: 'old', email: 'old@example.com', status: 'active', created_at: '2026-10-05T00:00:00Z' }], pagination: { page: 1, limit: 50, total: 1, totalPages: 1 } }))

    await waitFor(() => expect(screen.queryByText('old@example.com')).not.toBeInTheDocument())
    expect(screen.getByText('new@example.com')).toBeInTheDocument()
  })

  it('returns to a valid page after the last row on the final page is removed', async () => {
    let removed = false
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      if (String(url) === '/api/leads/lists') return listsOk()
      const page = Number(new URL(String(url), 'https://fixture.example').searchParams.get('page'))
      const leads = page === 1 ? [activeLead] : removed ? [] : [bouncedLead]
      return Response.json({ leads, pagination: { page, limit: 50, total: removed ? 50 : 51, totalPages: removed ? 1 : 2 } })
    }))
    render(<LeadsContent />)
    await screen.findByText(activeLead.email)
    fireEvent.click(screen.getByRole('button', { name: /next page/i }))
    await screen.findByText(bouncedLead.email)
    removed = true
    fireEvent.click(screen.getByRole('button', { name: /^refresh$/i }))
    expect(await screen.findByText(activeLead.email)).toBeInTheDocument()
    expect(screen.getByTestId('total-leads-count')).toHaveTextContent('50')
    expect(screen.queryByText('No leads yet')).not.toBeInTheDocument()
  })
})
