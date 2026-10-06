import { it, expect, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { AgentsDashboard } from '@/app/(dashboard)/agents/agents-dashboard';
it('shows missing AI setup and saves an actual brief instead of fake activity', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify(init ? { saved: true } : String(input).includes('/campaigns') ? { campaigns: [{ id: '11111111-1111-4111-8111-111111111111', name: 'Demo' }] } : { model: null, briefs: [], policies: [], drafts: [], runs: [], decisions: [] })));
    vi.stubGlobal('fetch', fetchMock);
    render(<AgentsDashboard />);
    await screen.findByRole('option', { name: 'Demo' });
    await screen.findByText(/AI is not configured/);
    expect(screen.queryByText('0 calls')).toBeNull();
    fireEvent.change(screen.getByLabelText('Audience'), { target: { value: 'Owners' } });
    fireEvent.change(screen.getByLabelText('Problem'), { target: { value: 'Slow follow up' } });
    fireEvent.change(screen.getByLabelText('Offer'), { target: { value: 'Email setup' } });
    fireEvent.change(screen.getByLabelText('Call to action'), { target: { value: 'Would a demo help?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save offer brief' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url, init]) => String(url) === '/api/outreach/agents' && init?.method === 'POST' && JSON.parse(String(init.body)).action === 'brief')).toBe(true));
    vi.unstubAllGlobals();
});
it('saves manual copy without enabling paid AI', async () => { const id = '11111111-1111-4111-8111-111111111111', brief = { audience: 'Owners', problem: 'Slow follow up', offer: 'Email setup', tone: 'plain', cta: 'Would a demo help?', exclusions: [], claims: [], faqs: [] }; const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => new Response(JSON.stringify(init ? { status: 'draft' } : String(input).includes('/campaigns') ? { campaigns: [{ id, name: 'Demo' }] } : { model: null, briefs: [{ campaign_id: id, revision: 1, brief }], policies: [], drafts: [], runs: [], decisions: [] }))); vi.stubGlobal('fetch', fetchMock); render(<AgentsDashboard />); await screen.findByRole('option', { name: 'Demo' }); await waitFor(() => expect(screen.getByRole('button', { name: 'Use approved brief text' }).hasAttribute('disabled')).toBe(false)); fireEvent.click(screen.getByRole('button', { name: 'Use approved brief text' })); fireEvent.click(screen.getByRole('button', { name: 'Save manual draft' })); await screen.findByText('Draft saved; owner approval required.'); expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST' && JSON.parse(String(init.body)).action === 'manualDraft')).toBe(true); expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST' && JSON.parse(String(init.body)).action === 'copy')).toBe(false); vi.unstubAllGlobals(); });
