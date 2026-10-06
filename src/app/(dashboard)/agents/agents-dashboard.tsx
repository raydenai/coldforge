'use client';
import {BriefReferenceFields} from './brief-reference-fields';
import {ConversationPicker} from './conversation-picker';
import type {Brief} from '@/lib/outreach/agents/core';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { stateSchema, type AgentState } from '@/lib/outreach/agents/core';
import { briefSchema, policySchema } from '@/lib/outreach/agents/core';
const blank = { audience: '', problem: '', offer: '', tone: 'plain', cta: '', exclusions: [], claims: [], faqs: [] };
const campaignsSchema = z.object({ campaigns: z.array(z.object({ id: z.string(), name: z.string() })) });
export function AgentsDashboard() {
    const [state, setState] = useState<AgentState | null>(null), [campaigns, setCampaigns] = useState<{
        id: string;
        name: string;
    }[]>([]), [campaignId, setCampaignId] = useState(''), [brief, setBrief] = useState(blank), [claims, setClaims] = useState<Brief['claims']>([]), [faqs, setFaqs] = useState<Brief['faqs']>([]), [exclusions, setExclusions] = useState(''), [policy, setPolicy] = useState(policySchema.parse({})), [model, setModel] = useState(''), [apiKey, setApiKey] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [manualSubject, setManualSubject] = useState(''), [manualBody, setManualBody] = useState(''), [threadId, setThreadId] = useState(''), [apply, setApply] = useState<{
        draftId: string;
        revision: string;
        stepId: string;
        steps: {
            id: string;
            order: number;
        }[];
    } | null>(null);
    const load = useCallback(async () => { const [a, c] = await Promise.all([fetch('/api/outreach/agents'), fetch('/api/campaigns?limit=100')]); if (!a.ok || !c.ok)
        throw Error('Agent setup is available to organization owners and admins'); const data = stateSchema.parse(await a.json()), campaignData = campaignsSchema.parse(await c.json()); setState(data); setCampaigns(campaignData.campaigns); setCampaignId(id => id || campaignData.campaigns[0]?.id || ''); setModel(data.model?.model ?? ''); }, []);
    useEffect(() => { void load().catch(() => setError('Unable to load agent configuration. Sign in as an owner or admin.')); }, [load]);
    useEffect(() => { const b = state?.briefs.find(x => x.campaign_id === campaignId); setBrief(b ? { audience: b.brief.audience, problem: b.brief.problem, offer: b.brief.offer, tone: b.brief.tone, cta: b.brief.cta, exclusions: [], claims: [], faqs: [] } : blank); setExclusions((b?.brief.exclusions ?? []).join('\n')); setClaims(b?.brief.claims ?? []); setFaqs(b?.brief.faqs ?? []); setPolicy(state?.policies.find(x => x.campaign_id === campaignId)?.policy ?? policySchema.parse({})); }, [campaignId, state]);
    async function save(payload: unknown) { setBusy(true); setError(''); setNotice(''); try {
        const r = await fetch('/api/outreach/agents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }), data = await r.json();
        if (!r.ok)
            throw Error(typeof data.error === 'string' ? data.error : 'Agent operation was not accepted');
        if (data.status === 'rejected') {
            setError(typeof data.reason === 'string' ? data.reason : 'Generated output was rejected; no draft was saved');
        }
        else if (typeof data.held === 'string')
            setNotice(data.held === 'setup_required' ? 'AI is not configured; no classification or email was sent.' : data.held === 'model_outcome_unknown' ? 'Model outcome is unconfirmed and held. Do not retry this request.' : data.held === 'daily_budget' ? 'Daily model budget reached; this request is held.' : 'This conversation is held or already processed. Review activity before trying again.');
        else
            setNotice(data.status === 'unknown' ? 'Model outcome is unknown and held; do not replay.' : data.status === 'held' ? 'This context is already held or the daily budget is exhausted.' : data.status === 'review_required' ? 'Decision saved for human review; no email sent.' : data.status === 'approved' ? 'Template decision approved; worker authorization is still required.' : data.status === 'draft' ? 'Draft saved; owner approval required.' : 'Saved. No email was sent by this action.');
        setApiKey('');
        await load();
    }
    catch (e) {
        setError(e instanceof Error ? e.message : 'Operation failed');
    }
    finally {
        setBusy(false);
    } }
    async function loadSequence(draftId: string, campaign: string) { try {
        const response = await fetch(`/api/campaigns/${campaign}/sequences`);
        if (!response.ok)
            throw Error('Sequence unavailable');
        const sequence = z.object({ expectedUpdatedAt: z.string(), steps: z.array(z.object({ id: z.string(), order: z.number() })) }).parse(await response.json());
        setApply({ draftId, revision: sequence.expectedUpdatedAt, stepId: sequence.steps[0]?.id ?? '', steps: sequence.steps });
    }
    catch {
        setError('Unable to load sequence. Add a campaign step first.');
    } }
    const b = state?.briefs.find(x => x.campaign_id === campaignId), p = state?.policies.find(x => x.campaign_id === campaignId);
    return <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-8"><div><h1 className="text-2xl font-semibold">Agents</h1><p className="text-muted-foreground">Draft from approved facts. Review conversations. Automatic replies use approved FAQ text only.</p></div>{error && <p role="alert" className="text-destructive">{error}</p>}{notice && <p role="status">{notice}</p>}
 <section className="space-y-3 rounded-lg border p-4"><h2 className="font-semibold">AI configuration</h2><p>{state?.model?.configured ? `Configured model: ${state.model.model}` : 'AI is not configured. Manual briefs and approved templates remain available.'}</p><div className="grid gap-3 md:grid-cols-2"><label>Explicit model ID<Input value={model} onChange={e => setModel(e.target.value)} placeholder="Model available to your Anthropic account"/></label><label>Anthropic API key<Input type="password" autoComplete="off" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={state?.model?.configured ? 'Leave blank to keep current key' : 'Required for paid generation'}/></label></div><Button disabled={busy || !model} onClick={() => void save({ action: 'model', model, expectedRevision: state?.model?.revision ?? 0, ...(apiKey ? { apiKey } : {}) })}>Save AI configuration</Button><p className="text-sm text-muted-foreground">Keys are stored encrypted and never returned. One reserved request per context; uncertain outcomes require review.</p></section>
 <label>Campaign<select className="ml-3 rounded border p-2" value={campaignId} onChange={e => setCampaignId(e.target.value)}>{campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
 <section className="space-y-3 rounded-lg border p-4"><h2 className="font-semibold">Offer brief</h2><div className="grid gap-3 md:grid-cols-2">{(['audience', 'problem', 'offer', 'tone', 'cta'] as const).map(key => <label key={key}>{key === 'cta' ? 'Call to action' : key[0]!.toUpperCase() + key.slice(1)}<Input value={brief[key]} onChange={e => setBrief({ ...brief, [key]: e.target.value })}/></label>)}</div><label className="block">Exclusions (one per line)<Textarea value={exclusions} onChange={e => setExclusions(e.target.value)}/></label><BriefReferenceFields claims={claims} faqs={faqs} onClaims={setClaims} onFaqs={setFaqs} disabled={busy}/><p className="text-sm text-muted-foreground">Saving asserts that claims are supported by the supplied evidence and FAQ answers are approved. Automated replies cannot invent new prose.</p><Button disabled={busy || !campaignId} onClick={() => { try {
        void save({ action: 'brief', campaignId, expectedRevision: b?.revision ?? 0, brief: briefSchema.parse({ ...brief, exclusions: exclusions.split('\n').map(x => x.trim()).filter(Boolean), claims, faqs }) });
    }
    catch {
        setError('Complete the brief, claim evidence and FAQ answers before saving');
    } }}>Save offer brief</Button></section>
 <section className="space-y-3 rounded-lg border p-4"><h2 className="font-semibold">Conversation policy</h2><label className="block"><input type="checkbox" checked={policy.enabled} onChange={e => setPolicy({ ...policy, enabled: e.target.checked })}/> Enable approved FAQ automation for eligible conversations</label><p className="text-sm">Explicit human takeover always wins. Opt-outs, out-of-office and injection markers require a stop or review. Schedule uses UTC.</p><label>Minimum confidence<Input type="number" min="0.9" max="1" step="0.01" value={policy.minConfidence} onChange={e => setPolicy({ ...policy, minConfidence: Number(e.target.value) })}/></label><div className="flex flex-wrap gap-4">{(['question', 'interested', 'objection'] as const).map(intent => <label key={intent}><input type="checkbox" checked={policy.allowedIntents.includes(intent)} onChange={e => setPolicy({ ...policy, allowedIntents: e.target.checked ? [...policy.allowedIntents, intent] : policy.allowedIntents.filter(i => i !== intent) })}/>{intent}</label>)}</div><div className="grid gap-3 md:grid-cols-4">{(['dailyCalls', 'maxReplies', 'startHour', 'endHour'] as const).map(key => <label key={key}>{({ dailyCalls: 'Daily model calls', maxReplies: 'Replies per conversation', startHour: 'UTC start hour', endHour: 'UTC end hour' })[key]}<Input type="number" value={policy[key]} onChange={e => setPolicy({ ...policy, [key]: Number(e.target.value) })}/></label>)}</div><Button disabled={busy || !campaignId} onClick={() => { try {
        void save({ action: 'policy', campaignId, expectedRevision: p?.revision ?? 0, policy: policySchema.parse(policy) });
    }
    catch {
        setError('Invalid limits or UTC window');
    } }}>Save policy</Button></section>
 <section className="space-y-3 rounded-lg border p-4"><h2 className="font-semibold">Copy drafts</h2><div className="space-y-3"><label className="block">Manual draft subject<Input value={manualSubject} onChange={e => setManualSubject(e.target.value)}/></label><label className="block">Manual draft body<Textarea rows={5} value={manualBody} onChange={e => setManualBody(e.target.value)}/></label><p className="text-sm text-muted-foreground">Use exact approved claim, offer, problem and call-to-action text. Manual drafts do not require AI credentials.</p><Button variant="outline" disabled={busy || !b} onClick={() => { if (b) {
        setManualSubject(b.brief.offer);
        setManualBody([...b.brief.claims.map(c => c.text), b.brief.offer, b.brief.cta].join('\n\n'));
    } }}>Use approved brief text</Button><Button disabled={busy || !b || !manualSubject || !manualBody} onClick={() => void save({ action: 'manualDraft', campaignId, copy: { subject: manualSubject, body: manualBody, claimIds: b?.brief.claims.map(c => c.id) ?? [] } })}>Save manual draft</Button></div><Button disabled={busy || !b || !p || !state?.model?.configured} onClick={() => void save({ action: 'copy', campaignId })}>Generate fact-based draft</Button>{state?.drafts.filter(d => d.campaign_id === campaignId).map(d => <article key={d.id} className="space-y-2 border-t pt-3"><strong>{d.content.subject}</strong><pre className="whitespace-pre-wrap text-sm">{d.content.body}</pre><p>{d.approved_at ? 'Approved' : 'Draft — approval required'}</p>{!d.approved_at && <Button disabled={busy} onClick={() => void save({ action: 'approveDraft', runId: d.id })}>Approve draft</Button>}<Link className="block underline" href={`/campaigns/${d.campaign_id}`}>Review campaign sequence</Link><Button variant="outline" disabled={busy || !d.approved_at} onClick={() => void loadSequence(d.id, d.campaign_id)}>Choose sequence step</Button>{apply?.draftId === d.id && <div className="flex flex-wrap gap-3"><label>Sequence step<select className="ml-2 border p-2" value={apply.stepId} onChange={e => setApply({ ...apply, stepId: e.target.value })}>{apply.steps.map(step => <option key={step.id} value={step.id}>Step {step.order}</option>)}</select></label><Button disabled={busy || !apply.stepId} onClick={() => void save({ action: 'applyDraft', runId: d.id, stepId: apply.stepId, expectedUpdatedAt: apply.revision })}>Apply approved draft</Button></div>}<p className="text-xs text-muted-foreground">Applies atomically to a draft or paused campaign; other steps are preserved. Changes require fresh approval.</p></article>)}</section>
 <section className="space-y-3 rounded-lg border p-4"><h2 className="font-semibold">Activity and review</h2><ConversationPicker value={threadId} onChange={setThreadId} disabled={busy}/><Button disabled={busy || !threadId} onClick={() => void save({ action: 'process', threadId })}>Classify and prepare for review</Button><p className="text-sm text-muted-foreground">This action prepares a decision. Approved automatic replies are dispatched by the worker; classification does not claim delivery.</p>{state && state.runs.length === 0 && <p>No model runs recorded.</p>}{state?.runs.map(r => <p key={r.id}>{r.kind}: {r.status} · requested {r.model}{r.served_model ? ` / served ${r.served_model}` : ''} · {new Date(r.created_at).toLocaleString()}{r.error_code ? ` · ${r.error_code}` : ''}</p>)}{state?.decisions.map(d => <div key={d.id}><p>{d.classification.intent}: {d.classification.reason} · {d.classification.source}{d.classification.model ? ` / ${d.classification.model}` : ''} · {d.approved ? 'Template approved; current authorization required' : 'Human review required'}</p><Link className="underline" href={`/inbox?thread=${d.thread_id}`}>Open conversation / take over</Link></div>)}</section></div>;
}
