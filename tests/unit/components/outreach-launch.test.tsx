import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import CampaignDetailPage from '@/app/(dashboard)/campaigns/[id]/page'
vi.mock('next/navigation', () => ({ useParams: () => ({ id: 'campaign' }) }))
import { CampaignLaunch } from '@/app/(dashboard)/campaigns/[id]/campaign-launch'
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const props = { campaignId: 'campaign', status: 'draft', mailboxIds: ['m1'], onStatusChanged: vi.fn(), onNavigate: vi.fn() }
const configuration = { sender_name: 'Jane', sender_company: 'Example', business_address: '1 Main Street', sender_email: 'sender@example.com', mailbox_id: 'm1', mailbox_daily_limit: 10 }
function fixture(url: string) {
 if (url === '/api/winnr/connection') return { canManage: true, connection: { id: 'connection', version: 2, account: { permissions: ['read', 'write'] } } }
 if (url === '/api/winnr/smtp') return { connectionId: 'connection', connectionVersion: 2, mailboxes: [{ providerMailboxId: 'm1', email: 'sender@example.com' }] }
 return { ready: true, configuration, warmupReadiness: 'unknown' }
}
it('saves real sender identity with an exact bounded configure payload', async () => {
 const fetchMock = vi.fn(async (url: string, init?: RequestInit) => Response.json(init?.method === 'POST' ? { configured: true } : fixture(url)))
 vi.stubGlobal('fetch', fetchMock); render(<CampaignLaunch {...props} />)
 const input = await screen.findByLabelText('Sender name'); fireEvent.change(input, { target: { value: 'Jane Approved' } })
 fireEvent.click(screen.getByRole('button', { name: 'Save sender identity' }))
 await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true))
 expect(JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body))).toEqual({ action: 'configure', campaignId: 'campaign', senderName: 'Jane Approved', senderCompany: 'Example', businessAddress: '1 Main Street', senderEmail: 'sender@example.com', mailboxId: 'm1', mailboxDailyLimit: 10 })
})
it('resumes a paused campaign through its existing action endpoint', async () => {
 const fetchMock = vi.fn(async (url: string, init?: RequestInit) => Response.json(init?.method === 'POST' ? { success: true, status: 'active' } : fixture(url)))
 vi.stubGlobal('fetch', fetchMock); render(<CampaignLaunch {...props} status="paused" />)
 fireEvent.click(await screen.findByRole('button', { name: 'Resume campaign' }))
 await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/api/campaigns/campaign/actions')).toBe(true))
 expect(JSON.parse(String(fetchMock.mock.calls.find(([url]) => url === '/api/campaigns/campaign/actions')?.[1]?.body))).toEqual({ action: 'resume' })
})
it('holds an uncertain manual send and never automatically retries it', async () => {
 const fetchMock = vi.fn(async (url: string, init?: RequestInit) => { if (init?.method === 'POST') throw new Error('Network lost'); return Response.json(fixture(url)) })
 vi.stubGlobal('fetch', fetchMock); render(<CampaignLaunch {...props} status="active" />)
 const button = await screen.findByRole('button', { name: 'Send next eligible email' }); fireEvent.click(button); fireEvent.click(button)
 expect(await screen.findByText(/Outcome unknown.*do not resubmit/i)).toBeInTheDocument()
 expect(button).toBeDisabled()
 expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
 expect(JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body))).toEqual({ action: 'dispatch', campaignId: 'campaign', limit: 1 })
})
it('blocks launch controls for members and explains validation blockers', async () => {
 vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url === '/api/winnr/connection' ? { ...fixture(url), canManage: false } : { ...fixture(url), ready: false, reason: 'eligible_audience_required' })))
 render(<CampaignLaunch {...props} />)
 expect(await screen.findByText(/Only owners and admins/)).toBeInTheDocument()
 expect(screen.queryByRole('button', { name: 'Start campaign' })).not.toBeInTheDocument()
})
it('read errors remain unverified and prevent sending', async () => {
 vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { message: 'Readiness unavailable' } }, { status: 503 })))
 render(<CampaignLaunch {...props} status="active" />)
 expect(await screen.findByText('Readiness unavailable')).toBeInTheDocument()
 expect(screen.queryByRole('button', { name: 'Send next eligible email' })).not.toBeInTheDocument()
})
it('discards a late readiness response after the campaign changes', async () => {
 let release: (response: Response) => void = () => {}
 const pending = new Promise<Response>(resolve => { release = resolve })
 const fetchMock = vi.fn(async (url: string) => url.includes('campaignId=campaign') && !url.includes('campaignId=other') ? pending : Response.json(url.includes('campaignId=other') ? { ready: true, configuration: { ...configuration, sender_name: 'Current Sender' } } : fixture(url)))
 vi.stubGlobal('fetch', fetchMock)
 const view = render(<CampaignLaunch {...props} />)
 await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url.includes('campaignId=campaign'))).toBe(true))
 view.rerender(<CampaignLaunch {...props} campaignId="other" />)
 await waitFor(() => expect(screen.getByLabelText('Sender name')).toHaveValue('Current Sender'))
 release(Response.json({ ready: false, reason: 'invalid_schedule', configuration: { ...configuration, sender_name: 'Old Sender' } }))
 await waitFor(() => expect(screen.getByLabelText('Sender name')).toHaveValue('Current Sender'))
 expect(screen.queryByText('Setup blocked')).not.toBeInTheDocument()
})
it('shows exact unknown attempt references and preserves the hold across refresh', async () => {
 vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => Response.json(init?.method === 'POST' ? { outcomes: [{ attemptId: 'attempt-held', receipt: { outcome: 'unknown' }, settlement: { settled: true, status: 'unknown' } }] } : fixture(url))))
 render(<CampaignLaunch {...props} status="active" />)
 fireEvent.click(await screen.findByRole('button', { name: 'Send next eligible email' }))
 expect(await screen.findByText(/Outcome unknown for attempt attempt-held/)).toBeInTheDocument()
 await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh readiness' })).not.toBeDisabled())
 fireEvent.click(screen.getByRole('button', { name: 'Refresh readiness' }))
 await screen.findByText('Setup checks passed')
 expect(screen.getByRole('button', { name: 'Send next eligible email' })).toBeDisabled()
})
it('labels saved SMTP acceptance separately from delivery', async () => {
 vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => Response.json(init?.method === 'POST' ? { outcomes: [{ attemptId: 'accepted', receipt: { outcome: 'accepted' }, settlement: { settled: true, status: 'accepted' } }] } : fixture(url))))
 render(<CampaignLaunch {...props} status="active" />)
 fireEvent.click(await screen.findByRole('button', { name: 'Send next eligible email' }))
 expect(await screen.findByText('SMTP accepted the email and the receipt was saved. Recipient delivery is not yet measured.')).toBeInTheDocument()
})
it('requires explicit stop confirmation and posts only kill once', async () => {
 const fetchMock = vi.fn(async (url: string, init?: RequestInit) => Response.json(init?.method === 'POST' ? { killed: true } : fixture(url)))
 vi.stubGlobal('fetch', fetchMock); render(<CampaignLaunch {...props} status="active" />)
 fireEvent.click(await screen.findByRole('button', { name: 'Stop campaign' }))
 expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
 expect(screen.getByText(/Unknown outcomes remain held/)).toBeInTheDocument()
 fireEvent.click(screen.getByRole('button', { name: 'Confirm stop' }))
 await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1))
 expect(JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body))).toEqual({ action: 'kill', campaignId: 'campaign' })
})

it('campaign read failure is unavailable rather than a fabricated 404', async () => {
 vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'unavailable' }, { status: 503 })))
 render(<CampaignDetailPage />)
 expect(await screen.findByText('Campaign unavailable')).toBeInTheDocument()
 expect(screen.queryByText('Campaign not found')).not.toBeInTheDocument()
 expect(screen.getByRole('button', { name: 'Retry campaign read' })).toBeInTheDocument()
})
it('pauses active campaigns through the existing actions boundary', async () => {
 const fetchMock = vi.fn(async (url: string, init?: RequestInit) => Response.json(init?.method === 'POST' ? { success: true, status: 'paused' } : fixture(url)))
 vi.stubGlobal('fetch', fetchMock); render(<CampaignLaunch {...props} status="active" />)
 fireEvent.click(await screen.findByRole('button', { name: 'Pause campaign' }))
 await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url === '/api/campaigns/campaign/actions')).toBe(true))
 expect(JSON.parse(String(fetchMock.mock.calls.find(([url]) => url === '/api/campaigns/campaign/actions')?.[1]?.body))).toEqual({ action: 'pause' })
})
