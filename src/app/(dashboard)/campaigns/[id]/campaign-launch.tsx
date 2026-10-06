'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
interface Props { campaignId: string; status: string; mailboxIds: string[]; onStatusChanged: () => void; onNavigate: (tab: string) => void }
interface Configuration { sender_name: string; sender_company: string; business_address: string; sender_email: string; mailbox_id: string; mailbox_daily_limit: number; killed?: boolean }
interface Readiness { ready: boolean; reason?: string; configuration?: Configuration; warmupReadiness?: string }
interface Connection { canManage: boolean; connection: { id: string; version: number; account: { permissions: string[] } } | null }
interface Smtp { connectionId: string | null; connectionVersion?: number; mailboxes: { providerMailboxId: string; email: string }[] }
interface Outcome { attemptId?: string; outcome?: string; code?: string; receipt?: { outcome: string }; settlement?: { settled?: boolean; status?: string } }
const reasons: Record<string, string> = {
 reply_receiving_required: 'Configure a verified reply-receiving webhook in Winnr before launching.', ingestion_not_configured: 'Configure a verified reply-receiving webhook in Winnr before launching.',
 sender_identity_required: 'Save your approved sender identity and business address.', sender_binding: 'Select current Winnr mailboxes in Settings, then save sender identity again.',
 smtp_not_configured: 'Import SMTP credentials for this mailbox in Winnr.', canonical_sender_missing: 'Refresh SMTP setup in Winnr to verify the sender account.',
 provider_mailbox_unavailable: 'The provider mailbox must be active with a known daily limit covering your configured cap.', unsupported_sequence: 'Write a continuous sequence using supported always or not_replied conditions.',
 invalid_schedule: 'Choose a valid timezone, sending days, hours and limits in Settings.', eligible_audience_required: 'Add an eligible audience with current verified email evidence. Suppressed or replied contacts remain stopped.',
 validation_unavailable: 'Email validation is unavailable. Open lead validation to finish setup.', unknown_touch_requires_reconciliation: 'An unknown send requires reconciliation. It cannot be retried or released here.',
}
async function read<T>(url: string, init?: RequestInit): Promise<T> {
 const response = await fetch(url, { cache: 'no-store', ...init }); const data = await response.json()
 if (!response.ok) throw new Error(reasons[data.error?.message] ?? data.error?.message ?? 'Launch state could not be verified. Refresh before continuing.')
 return data as T
}
export function CampaignLaunch({ campaignId, status, mailboxIds, onStatusChanged, onNavigate }: Props) {
 const [state, setState] = useState<Readiness | null>(null), [connection, setConnection] = useState<Connection | null>(null), [smtp, setSmtp] = useState<Smtp | null>(null)
 const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [held, setHeld] = useState(false), [confirmKill, setConfirmKill] = useState(false)
 const [name, setName] = useState(''), [company, setCompany] = useState(''), [address, setAddress] = useState(''), [mailboxId, setMailboxId] = useState(''), [dailyLimit, setDailyLimit] = useState('10')
 const generation = useRef(0), locked = useRef(false)
 const invalidate = useCallback(() => { ++generation.current }, [])
 const refresh = useCallback(async () => {
  const request = ++generation.current; setLoading(true); setError(null); setState(null); setConnection(null); setSmtp(null)
  try {
   const account = await read<Connection>('/api/winnr/connection')
   if (request !== generation.current) return
   setConnection(account)
   if (!account.canManage) return
   const [ready, observed] = await Promise.all([read<Readiness>(`/api/outreach/dispatch?campaignId=${encodeURIComponent(campaignId)}`), read<Smtp>('/api/winnr/smtp')])
   if (request !== generation.current) return
   if (observed.connectionId !== (account.connection?.id ?? null) || (observed.connectionId && observed.connectionVersion !== account.connection?.version)) throw new Error('The Winnr connection changed. Refresh before continuing.')
   if (typeof ready.ready !== 'boolean' || !Array.isArray(observed.mailboxes)) throw new Error('Launch observations are unverified.')
   setState(ready); setSmtp(observed)
   if (ready.configuration) { const cfg = ready.configuration; setName(cfg.sender_name); setCompany(cfg.sender_company); setAddress(cfg.business_address); setMailboxId(cfg.mailbox_id); setDailyLimit(String(cfg.mailbox_daily_limit)) }
  } catch (failure) { if (request === generation.current) setError(failure instanceof Error ? failure.message : 'Readiness is unavailable.') }
  finally { if (request === generation.current) setLoading(false) }
 }, [campaignId])
 useEffect(() => { setHeld(false); setNotice(null); setName(''); setCompany(''); setAddress(''); setMailboxId(''); setDailyLimit('10'); void refresh(); return invalidate }, [refresh, invalidate])
 const allowed = Boolean(connection?.canManage)
 const canWrite = Boolean(allowed && connection?.connection?.account.permissions.includes('write'))
 const options = smtp?.mailboxes.filter(item => mailboxIds.includes(item.providerMailboxId)) ?? []
 const chosen = options.find(item => item.providerMailboxId === mailboxId)
 const actionable = allowed && !busy && !loading && !error
 async function act(action: 'configure' | 'start' | 'resume' | 'pause' | 'dispatch' | 'kill') {
  if (locked.current || !actionable || (action === 'dispatch' && (held || !state?.ready || status !== 'active'))) return
  if ((action === 'start' || action === 'resume') && (!state?.ready || held)) return
  if (action === 'configure' && (!chosen || !canWrite || !['draft', 'paused'].includes(status))) return
  locked.current = true; setBusy(true); setNotice(null)
  const request = generation.current
  try {
   const result = await read<{ configured?: boolean; killed?: boolean; success?: boolean; outcomes?: Outcome[] }>(action === 'start' || action === 'resume' || action === 'pause' ? `/api/campaigns/${campaignId}/actions` : '/api/outreach/dispatch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action === 'start' || action === 'resume' || action === 'pause' ? { action } : action === 'configure' ? { action, campaignId, senderName: name.trim(), senderCompany: company.trim(), businessAddress: address.trim(), senderEmail: chosen?.email.trim().toLowerCase(), mailboxId, mailboxDailyLimit: Number(dailyLimit) } : action === 'dispatch' ? { action, campaignId, limit: 1 } : { action, campaignId }) })
   if (request !== generation.current) return
   if (action === 'dispatch') {
    if (!Array.isArray(result.outcomes)) throw new Error('Send result is unverified')
    const outcome = result.outcomes[0]
    const unknown = outcome && (outcome.outcome === 'unknown' || outcome.receipt?.outcome === 'unknown' || outcome.settlement?.status === 'unknown' || (outcome.receipt?.outcome === 'accepted' && outcome.settlement?.settled !== true))
    if (unknown) { setHeld(true); setNotice(`Outcome unknown${outcome.attemptId ? ` for attempt ${outcome.attemptId}` : ''}; do not resubmit. Reconciliation is required.`) }
    else if (outcome?.receipt?.outcome === 'accepted' && outcome.settlement?.status === 'accepted') setNotice('SMTP accepted the email and the receipt was saved. Recipient delivery is not yet measured.')
    else setNotice(outcome ? `No email accepted: ${outcome.code ?? outcome.settlement?.status ?? outcome.receipt?.outcome ?? 'blocked'}.` : 'No eligible email was available. No SMTP send was attempted.')
   } else {
    if (!(result.configured || result.killed || result.success)) throw new Error('Operation result is unverified')
    setNotice(action === 'configure' ? 'Sender identity saved. Refreshing readiness.' : action === 'kill' ? 'Campaign stopped. Already authorized sends cannot be retracted.' : action === 'pause' ? 'Campaign paused. Future authorization checks will refuse sends.' : 'Campaign activated. Use an explicit manual send below; continuous scheduling is not configured here.')
    setConfirmKill(false); if (action !== 'configure') onStatusChanged()
   }
   await refresh()
  } catch (failure) {
   if (request !== generation.current) return
   if (action === 'dispatch') { setHeld(true); setNotice('Outcome unknown; do not resubmit. Refresh observations and reconcile the durable attempt.') }
   else { setError(failure instanceof Error ? failure.message : 'Operation could not be verified. Refresh before continuing.') }
  } finally { locked.current = false; setBusy(false) }
 }
 return <Card>
  <CardHeader><CardTitle>Email launch</CardTitle><CardDescription>Approve sender identity, inspect current setup, then perform one explicit action. This screen does not run a continuous sender.</CardDescription></CardHeader>
  <CardContent className="space-y-5">
   {loading && <p role="status">Verifying launch setup…</p>}
   {error && <p role="alert" className="text-destructive">{error}</p>}
   {notice && <p role="status" className="break-words">{notice}</p>}
   {connection && !allowed && <p>Only owners and admins can configure or launch campaigns.</p>}
   {state && <div className="rounded-lg border p-4 space-y-2"><p className="font-medium">{state.ready ? 'Setup checks passed' : 'Setup blocked'}</p>{state.reason && <p>{reasons[state.reason] ?? (/reply|ingestion|webhook/.test(state.reason) ? 'Configure verified reply receiving in Winnr before launching.' : `Setup unavailable: ${state.reason}`)}</p>}<p className="text-sm text-muted-foreground">Warm-up readiness: Unknown. Provider state is an observation; SMTP acceptance and recipient delivery are separate outcomes.</p></div>}
   <nav aria-label="Launch setup" className="flex flex-wrap gap-3 text-sm"><Link className="underline" href="/winnr">Winnr / SMTP setup</Link><Link className="underline" href="/leads/validation">Lead validation</Link><Button variant="link" className="h-auto p-0" onClick={() => onNavigate('sequence')}>Sequence</Button><Button variant="link" className="h-auto p-0" onClick={() => onNavigate('settings')}>Settings</Button></nav>
   {allowed && state && <form className="grid gap-4 sm:grid-cols-2" onSubmit={event => { event.preventDefault(); void act('configure') }}>
    <div className="space-y-1"><Label htmlFor="launch-name">Sender name</Label><Input id="launch-name" value={name} onChange={event => setName(event.target.value)} required maxLength={100} disabled={busy} /></div>
    <div className="space-y-1"><Label htmlFor="launch-company">Sender company</Label><Input id="launch-company" value={company} onChange={event => setCompany(event.target.value)} required maxLength={200} disabled={busy} /></div>
    <div className="space-y-1 sm:col-span-2"><Label htmlFor="launch-address">Business address</Label><Input id="launch-address" value={address} onChange={event => setAddress(event.target.value)} required maxLength={1000} disabled={busy} /></div>
    <div className="space-y-1"><Label htmlFor="launch-mailbox">Sender mailbox</Label><select id="launch-mailbox" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={mailboxId} disabled={busy} onChange={event => setMailboxId(event.target.value)} required><option value="">Choose an imported campaign mailbox</option>{options.map(item => <option key={item.providerMailboxId} value={item.providerMailboxId}>{item.email}</option>)}</select><p className="text-xs text-muted-foreground">Only SMTP mailboxes selected in this campaign&apos;s Settings are offered.</p></div>
    <div className="space-y-1"><Label htmlFor="launch-limit">Mailbox daily limit</Label><Input id="launch-limit" type="number" min={1} max={1000} value={dailyLimit} onChange={event => setDailyLimit(event.target.value)} required disabled={busy} /><p className="text-xs text-muted-foreground">10/day is a conservative editable starting value. Provider limits and shared daily usage are checked before sending.</p></div>
    <div className="space-y-1 sm:col-span-2"><Label htmlFor="launch-email">Sender email</Label><Input id="launch-email" value={chosen?.email ?? ''} readOnly placeholder="Choose an imported campaign mailbox above" /></div>
    {!canWrite && <p className="sm:col-span-2">A current Winnr connection with write permission is required for sender setup.</p>}
    <Button type="submit" disabled={!actionable || !canWrite || !chosen || !['draft', 'paused'].includes(status)}>Save sender identity</Button>
   </form>}
   {allowed && state && <div className="flex flex-wrap gap-3">
    {['draft', 'paused'].includes(status) && <Button disabled={!actionable || !state.ready || held} onClick={() => void act(status === 'paused' ? 'resume' : 'start')}>{status === 'paused' ? 'Resume campaign' : 'Start campaign'}</Button>}
    {status === 'active' && <Button disabled={!actionable || !state.ready || held} onClick={() => void act('dispatch')}>Send next eligible email</Button>}
    {status === 'active' && <Button variant="outline" disabled={!actionable} onClick={() => void act('pause')}>Pause campaign</Button>}
    <Button variant="destructive" disabled={busy || loading} onClick={() => setConfirmKill(true)}>Stop campaign</Button>
   </div>}
   {confirmKill && <div role="dialog" aria-label="Confirm campaign stop" className="space-y-3 rounded-lg border border-destructive p-4"><p>Stop future authorizations and pause this campaign. An already authorized email may still be accepted. Unknown outcomes remain held; stopping does not release them.</p><Button variant="destructive" disabled={!actionable} onClick={() => void act('kill')}>Confirm stop</Button><Button variant="outline" disabled={busy} onClick={() => setConfirmKill(false)}>Cancel stop</Button></div>}
   <Button variant="outline" disabled={busy || loading} onClick={() => void refresh()}>Refresh readiness</Button>
  </CardContent>
 </Card>
}
