import '@testing-library/jest-dom/vitest'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { IngestionSetup } from '@/components/winnr/ingestion-setup'
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const props = { connectionId: 'connection', connectionVersion: 2, canManage: true, canWrite: true }
const configuration = { endpointId: 'endpoint', configured: true, callbackUrl: 'https://app.example/api/winnr/webhooks/endpoint', webhookId: 'webhook-1' }
function fixture(url: string) { return url === '/api/winnr/smtp' ? { connectionId: 'connection', connectionVersion: 2, mailboxes: [{ providerMailboxId: 'm1', email: 'sender@example.com' }] } : { connectionId: 'connection', connectionVersion: 2, configuration, capabilities: { providerWebhookCreation: false, manualSync: true } } }
it('shows exact callback subscriptions and associates an existing ID without secret inputs', async () => {
 const fetchMock = vi.fn(async (url: string, init?: RequestInit) => Response.json(init?.method === 'POST' ? configuration : fixture(url)))
 vi.stubGlobal('fetch', fetchMock); render(<IngestionSetup {...props} />)
 expect(await screen.findByText(configuration.callbackUrl)).toBeInTheDocument()
 for (const event of ['email.received', 'message.relayed', 'email.bounced', 'email.complained']) expect(screen.getByText(event)).toBeInTheDocument()
 fireEvent.change(screen.getByLabelText('Existing Winnr webhook ID'), { target: { value: 'webhook-2' } })
 fireEvent.click(screen.getByRole('button', { name: 'Associate existing webhook' }))
 await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true))
 expect(JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body))).toEqual({ action: 'associate', expectedConnectionId: 'connection', expectedConnectionVersion: 2, webhookId: 'webhook-2' })
 expect(screen.queryByLabelText(/secret|password|token/i)).not.toBeInTheDocument()
})
it('manual sync saves one page and exposes pending bodies and next cursor', async () => {
 const fetchMock = vi.fn(async (url: string, init?: RequestInit) => Response.json(init?.method === 'POST' ? { saved: 20, hydrated: 3, bodyUnavailable: 0, bodyPending: 17, bodyReady: false, nextCursor: 'cursor-2' } : fixture(url)))
 vi.stubGlobal('fetch', fetchMock); render(<IngestionSetup {...props} />)
 fireEvent.change(await screen.findByLabelText('Mailbox to sync'), { target: { value: 'm1' } })
 fireEvent.click(screen.getByRole('button', { name: 'Sync one inbox page' }))
 expect(await screen.findByText(/Bodies pending: 17/)).toBeInTheDocument()
 fireEvent.click(screen.getByRole('button', { name: 'Sync next inbox page' }))
 await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2))
 expect(JSON.parse(String(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')[1]?.[1]?.body))).toEqual({ expectedConnectionId: 'connection', expectedConnectionVersion: 2, mailboxId: 'm1', cursor: 'cursor-2' })
})
it('member view has no mutations', async () => {
 vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(fixture(url))))
 render(<IngestionSetup {...props} canManage={false} />)
 expect(await screen.findByText(/Only owners and admins/)).toBeInTheDocument()
 expect(screen.queryByRole('button', { name: 'Associate existing webhook' })).not.toBeInTheDocument()
})
it('stale connection observations block setup and sync', async () => {
 vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json({ ...fixture(url), connectionVersion: 1 })))
 render(<IngestionSetup {...props} />)
 expect(await screen.findByText(/connection changed/i)).toBeInTheDocument()
 expect(screen.queryByRole('button', { name: 'Sync one inbox page' })).not.toBeInTheDocument()
})
it('prepares a callback without requesting provider creation', async () => {
 const fetchMock = vi.fn(async (url: string, init?: RequestInit) => Response.json(init?.method === 'POST' ? configuration : fixture(url)))
 vi.stubGlobal('fetch', fetchMock); render(<IngestionSetup {...props} />)
 fireEvent.click(await screen.findByRole('button', { name: 'Prepare callback URL' }))
 await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true))
 expect(JSON.parse(String(fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body))).toEqual({ action: 'prepare', expectedConnectionId: 'connection', expectedConnectionVersion: 2 })
 expect(fetchMock.mock.calls.every(([url]) => url.startsWith('/api/'))).toBe(true)
})
