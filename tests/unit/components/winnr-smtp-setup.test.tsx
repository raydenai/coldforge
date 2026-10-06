import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SmtpSetup } from '@/components/winnr/smtp-setup'
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const props = { connectionId: 'connection', connectionVersion: 2, canManage: true, canWrite: true }
function fixtures(url: string) {
 return url.startsWith('/api/winnr/mailboxes') ? { items: [{ id: 'm1', email: 'sender@example.com' }], connectionId: 'connection', connectionVersion: 2, nextCursor: null, hasMore: false } : { mailboxes: [], connectionId: 'connection', connectionVersion: 2 }
}
it('imports only explicitly selected mailboxes with exact connection guards and refreshes metadata', async () => {
 const fetchMock = vi.fn(async (url: string, init?: RequestInit) => Response.json(init?.method === 'POST' ? { mailboxes: [{ providerMailboxId: 'm1', email: 'sender@example.com', syncedAt: '2026-10-05T00:00:00Z' }] } : fixtures(url)))
 vi.stubGlobal('fetch', fetchMock); render(<SmtpSetup {...props} />)
 fireEvent.click(await screen.findByLabelText('Import sender@example.com'))
 fireEvent.click(screen.getByRole('button', { name: 'Import selected SMTP credentials' }))
 await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true))
 const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
 expect(JSON.parse(String(post?.[1]?.body))).toEqual({ expectedConnectionId: 'connection', expectedConnectionVersion: 2, mailboxIds: ['m1'] })
 expect(await screen.findByText('SMTP credentials imported. Verifying stored metadata.')).toBeInTheDocument()
})
it('members cannot import', async () => {
 vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(fixtures(url))))
 render(<SmtpSetup {...props} canManage={false} />)
 expect(await screen.findByText(/Only owners and admins/)).toBeInTheDocument()
 expect(screen.queryByRole('button', { name: 'Import selected SMTP credentials' })).not.toBeInTheDocument()
})
it('rejects mailbox observations from another connection', async () => {
 vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json({ ...fixtures(url), connectionVersion: 1 })))
 render(<SmtpSetup {...props} />)
 expect(await screen.findByText(/connection changed/i)).toBeInTheDocument()
 expect(screen.queryByLabelText('Import sender@example.com')).not.toBeInTheDocument()
})
it('failed status reads are unavailable, never configured zero', async () => {
 vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { message: 'Storage unavailable' } }, { status: 503 })))
 render(<SmtpSetup {...props} />)
 expect(await screen.findByText('Storage unavailable')).toBeInTheDocument()
 expect(screen.queryByText('No SMTP credentials imported.')).not.toBeInTheDocument()
})
it('paginates owned observations and preserves explicit selection across pages', async () => {
 const fetchMock = vi.fn(async (url: string, init?: RequestInit) => Response.json(init?.method === 'POST' ? { mailboxes: [] } : url.includes('cursor=next') ? { ...fixtures(url), items: [{ id: 'm2', email: 'second@example.com' }] } : url.includes('/mailboxes') ? { ...fixtures(url), hasMore: true, nextCursor: 'next' } : fixtures(url)))
 vi.stubGlobal('fetch', fetchMock); render(<SmtpSetup {...props} />)
 fireEvent.click(await screen.findByLabelText('Import sender@example.com'))
 fireEvent.click(screen.getByRole('button', { name: 'Load more owned mailboxes' }))
 fireEvent.click(await screen.findByLabelText('Import second@example.com'))
 fireEvent.click(screen.getByRole('button', { name: 'Import selected SMTP credentials' }))
 await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true))
 expect(JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body)).mailboxIds).toEqual(['m1', 'm2'])
})
it('read-only provider tokens cannot import but can observe status', async () => {
 vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(fixtures(url))))
 render(<SmtpSetup {...props} canWrite={false} />)
 expect(await screen.findByText(/read and write permissions/)).toBeInTheDocument()
 expect(screen.queryByRole('button', { name: 'Import selected SMTP credentials' })).not.toBeInTheDocument()
})
