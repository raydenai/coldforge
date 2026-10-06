import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/inbox',
  useParams: () => ({}),
}))

import { UnifiedInbox } from '@/components/inbox'
import InboxContent from '@/app/(dashboard)/inbox/inbox-content'

const HTML_ONLY_BODY =
  '<img src="invalid" onerror="window.__inboxXss=1"><p>Hello from html</p>'

const thread = {
  id: 'thread-1',
  organizationId: 'org-1',
  campaignId: null,
  leadId: null,
  mailboxId: 'mailbox-1',
  subject: 'A saved question',
  participantEmail: 'lead@example.com',
  participantName: 'Lead Person',
  messageCount: 1,
  lastMessageAt: new Date().toISOString(),
  status: 'active' as const,
  category: 'interested' as const,
  sentiment: 'neutral' as const,
  assignedTo: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  preview: 'Preview text differs',
  hasUnread: false,
  lead: null,
  campaign: null,
}

const timeline = [{
  id: 'message-1',
  type: 'message' as const,
  direction: 'inbound' as const,
  messageId: 'mid-1',
  from: 'lead@example.com',
  fromName: 'Lead Person',
  to: 'ops@example.com',
  subject: 'A saved question',
  bodyText: '',
  bodyHtml: HTML_ONLY_BODY,
  timestamp: new Date().toISOString(),
  category: 'interested' as const,
  sentiment: 'neutral' as const,
  status: null,
  isAutoDetected: false,
}]

const detail = {
  thread,
  lead: null,
  campaign: null,
  mailbox: null,
  timeline,
  navigation: { prev: null, next: null, currentIndex: 1, total: 1 },
}

function inboxFetch() {
  return vi.fn(async (url: string | URL | Request) => {
    const target = String(url)
    if (target.startsWith('/api/inbox/thread-1')) return Response.json(detail)
    if (target.startsWith('/api/inbox')) return Response.json({ threads: [thread], stats: {} })
    return Response.json({ error: 'Unexpected request' }, { status: 400 })
  })
}

beforeEach(() => {
  vi.stubGlobal('fetch', inboxFetch())
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  delete (window as unknown as Record<string, unknown>).__inboxXss
})

describe('saved inbox HTML sinks render escaped plaintext', () => {
  it('UnifiedInbox -> MessageDetail converts an html-only body without executing it', async () => {
    render(<UnifiedInbox />)
    await userEvent.click(await screen.findByText('A saved question'))

    expect(await screen.findByText('Hello from html')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
    expect((window as unknown as Record<string, unknown>).__inboxXss).toBeUndefined()
  })

  it('routes the mounted composer through a visible transport gate and disables sends', async () => {
    render(<UnifiedInbox />)
    await userEvent.click(await screen.findByText('A saved question'))

    expect(
      await screen.findByText(/Reply setup required/),
    ).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /write a reply/i }))
    const send = await screen.findByRole('button', { name: /^send$/i })
    expect(send).toBeDisabled()
  })

  it('InboxContent converts the same html-only body without executing it', async () => {
    render(<InboxContent />)
    await userEvent.click(await screen.findByText('A saved question'))

    expect(await screen.findByText('Hello from html')).toBeInTheDocument()
    expect(document.querySelector('img')).toBeNull()
    expect((window as unknown as Record<string, unknown>).__inboxXss).toBeUndefined()
  })
})
