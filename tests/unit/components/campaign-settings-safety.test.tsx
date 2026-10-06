import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { CampaignSettings } from '@/app/(dashboard)/campaigns/[id]/campaign-settings'

function settingsFetch() {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url)
    if (target.startsWith('/api/winnr/mailboxes')) return Response.json({ items: [], nextCursor: null })
    if (target === '/api/campaigns/campaign-1' && init?.method === 'PUT') {
      return Response.json({ campaign: { settings: {}, updatedAt: 'rev-2', mailboxIds: [] } })
    }
    return Response.json({ error: 'Unexpected request' }, { status: 400 })
  })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('campaign settings safety repair', () => {
  it('renders historical false switches as mandatory true and persists them on save', async () => {
    const fetchMock = settingsFetch()
    vi.stubGlobal('fetch', fetchMock)
    const onUpdate = vi.fn()
    render(
      <CampaignSettings
        campaignId="campaign-1"
        settings={{ stopOnReply: false, stopOnBounce: false, unsubscribeLink: false, dailyLimit: 50, timezone: 'America/New_York' }}
        expectedUpdatedAt="rev-1"
        mailboxIds={[]}
        onUpdate={onUpdate}
      />,
    )

    const stopOnReply = screen.getByText('Stop on Reply').closest('div')?.parentElement as HTMLElement
    const stopOnBounce = screen.getByText('Stop on Bounce').closest('div')?.parentElement as HTMLElement
    const unsubscribe = screen.getByText('Include Unsubscribe Link').closest('div')?.parentElement as HTMLElement
    expect(within(stopOnReply).getByRole('switch')).toHaveAttribute('aria-checked', 'true')
    expect(within(stopOnBounce).getByRole('switch')).toHaveAttribute('aria-checked', 'true')
    expect(within(unsubscribe).getByRole('switch')).toHaveAttribute('aria-checked', 'true')

    const dailyLimit = screen.getByRole('spinbutton')
    fireEvent.change(dailyLimit, { target: { value: '75' } })
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }))

    await waitFor(() => expect(onUpdate).toHaveBeenCalled())
    const put = fetchMock.mock.calls.find(call => (call[1] as RequestInit | undefined)?.method === 'PUT')
    expect(put).toBeDefined()
    const body = JSON.parse(String((put?.[1] as RequestInit).body))
    expect(body.settings).toMatchObject({
      dailyLimit: 75,
      stopOnReply: true,
      stopOnBounce: true,
      unsubscribeLink: true,
    })
  })
})
