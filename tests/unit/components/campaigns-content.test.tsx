import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Toaster, toast } from 'sonner'
import CampaignDetailPage from '@/app/(dashboard)/campaigns/[id]/page'

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'campaign-1' }),
  useRouter: () => ({ push: vi.fn() }),
}))

import { CampaignsContent } from '@/app/(dashboard)/campaigns/campaigns-content'

const campaign = {
  id: 'campaign-1',
  name: 'Launch campaign',
  status: 'draft',
  stats: { sent: 0, opened: 0, clicked: 0, replied: 0, bounced: 0 },
  created_at: '2026-10-05T12:00:00Z',
  updated_at: '2026-10-05T12:00:00Z',
}

afterEach(() => {
  toast.dismiss()
  cleanup()
  vi.unstubAllGlobals()
})

async function clickCampaignAction() {
  const heading = await screen.findByRole('heading', { name: 'Launch campaign' })
  const card = heading.closest('[data-slot="card"]')
  if (!(card instanceof HTMLElement)) throw new Error('Campaign card is missing')
  // The first button in this card is its Start/Pause control; the second opens the menu.
  const actionButton = within(card).getAllByRole('button')[0]
  if (!actionButton) throw new Error('Campaign action button is missing')
  await userEvent.click(actionButton)
  return card
}

function mockCampaignApi(initialStatus: string, responseBody: object, responseStatus = 200) {
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (url === '/api/campaigns' && !init?.method) {
      return Response.json({ campaigns: [{ ...campaign, status: initialStatus }] })
    }
    if (url === '/api/campaigns/campaign-1/actions' && init?.method === 'POST') {
      return Response.json(responseBody, { status: responseStatus })
    }
    return Response.json({ error: 'Method not allowed' }, { status: 405 })
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<><CampaignsContent /><Toaster /></>)
  return fetchMock
}

describe('campaign list actions', () => {
  it.each([
    { initial: 'draft', action: 'start', returned: 'active' },
    { initial: 'active', action: 'pause', returned: 'paused' },
  ])('POSTs $action and displays the endpoint status', async ({ initial, action, returned }) => {
    const fetchMock = mockCampaignApi(initial, {
      success: true, status: returned, message: `Campaign ${action}ed successfully`,
    })
    const card = await clickCampaignAction()

    await waitFor(() => expect(within(card).getByText(returned)).toBeInTheDocument())
    expect(fetchMock).toHaveBeenLastCalledWith('/api/campaigns/campaign-1/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action }),
    })
  })

  it('uses the returned campaign status instead of assuming the requested status', async () => {
    mockCampaignApi('draft', { campaign: { id: campaign.id, status: 'paused' } })
    const card = await clickCampaignAction()

    await waitFor(() => expect(within(card).getByText('paused')).toBeInTheDocument())
    expect(within(card).queryByText('active')).not.toBeInTheDocument()
    expect(await screen.findByText('Campaign paused')).toBeInTheDocument()
    expect(screen.queryByText('Campaign started')).not.toBeInTheDocument()
  })

  it('rejects an invalid success status without claiming success', async () => {
    mockCampaignApi('draft', { success: true, status: 'not-a-status' })
    const card = await clickCampaignAction()
    expect(await screen.findByText('Failed to update campaign')).toBeInTheDocument()
    expect(within(card).getByText('draft')).toBeInTheDocument()
    expect(screen.queryByText('Campaign started')).not.toBeInTheDocument()
  })

  it('shows a rejected start reason and preserves the current status', async () => {
    mockCampaignApi('draft', { error: 'Campaign must have at least one mailbox' }, 400)
    const card = await clickCampaignAction()

    expect(await screen.findByText('Campaign must have at least one mailbox')).toBeInTheDocument()
    expect(within(card).getByText('draft')).toBeInTheDocument()
    expect(within(card).queryByText('active')).not.toBeInTheDocument()
    expect(screen.queryByText('Campaign started')).not.toBeInTheDocument()
  })
})


describe('campaign detail actions', () => {
  it.each(['draft', 'active'])('opens readiness-gated launch controls for %s', async initial => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (url === '/api/campaigns/campaign-1' && !init?.method) {
        return Response.json({ campaign: {
          ...campaign, status: initial, type: 'cold', settings: {},
          leadListIds: ['list-1'], mailboxIds: ['mailbox-1'],
          createdAt: campaign.created_at, updatedAt: campaign.updated_at,
        } })
      }
      if (url === '/api/campaigns/campaign-1/sequences') return Response.json({ steps: [] })
      if (url === '/api/winnr/connection') return Response.json({ canManage: true, connection: { id: 'connection', version: 1, account: { permissions: ['read', 'write'] } } })
      if (url === '/api/winnr/smtp') return Response.json({ connectionId: 'connection', connectionVersion: 1, mailboxes: [] })
      if (url === '/api/outreach/dispatch?campaignId=campaign-1') return Response.json({ ready: false, reason: 'eligible_audience_required' })
      return Response.json({ error: 'Unexpected request' }, { status: 400 })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<><CampaignDetailPage /><Toaster /></>)
    await userEvent.click(await screen.findByRole('button', { name: 'Open launch controls' }))
    expect(await screen.findByText('Setup blocked')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: initial === 'draft' ? 'Start campaign' : 'Send next eligible email' })).toBeDisabled()
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  })
})
