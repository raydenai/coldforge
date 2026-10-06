'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
interface Props { connectionId: string; connectionVersion: number; canManage: boolean; canWrite: boolean }
interface Configuration { endpointId: string; configured: boolean; callbackUrl: string; webhookId?: string }
interface Observation { connectionId: string | null; connectionVersion?: number }
interface Setup extends Observation { configuration: Configuration | null; capabilities: { manualSync: boolean; providerWebhookCreation: boolean } }
interface Mailbox { providerMailboxId: string; email: string }
interface Smtp extends Observation { mailboxes: Mailbox[] }
interface Sync { saved: number; hydrated: number; bodyUnavailable: number; bodyPending: number; bodyReady: boolean; nextCursor: string | null }
const events = ['email.received', 'message.relayed', 'email.bounced', 'email.complained']
async function read<T>(url: string, init?: RequestInit): Promise<T> {
 const response = await fetch(url, { cache: 'no-store', ...init }); const data = await response.json()
 if (!response.ok) throw new Error(data.error?.message ?? 'Reply-receiving observations are unavailable.')
 return data as T
}
export function IngestionSetup({ connectionId, connectionVersion, canManage, canWrite }: Props) {
 const [setup, setSetup] = useState<Setup | null>(null), [mailboxes, setMailboxes] = useState<Mailbox[]>([])
 const [webhookId, setWebhookId] = useState(''), [mailboxId, setMailboxId] = useState(''), [sync, setSync] = useState<Sync | null>(null)
 const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null)
 const generation = useRef(0), locked = useRef(false)
 const matches = useCallback((value: Observation) => value.connectionId === connectionId && value.connectionVersion === connectionVersion, [connectionId, connectionVersion])
 const invalidate = useCallback(() => { ++generation.current }, [])
 const refresh = useCallback(async () => {
  const request = ++generation.current; setLoading(true); setError(null); setSetup(null); setMailboxes([]); setSync(null)
  try {
   const [observed, smtp] = await Promise.all([read<Setup>('/api/inbox/sync'), read<Smtp>('/api/winnr/smtp')])
   if (request !== generation.current) return
   if (!matches(observed) || !matches(smtp)) throw new Error('The connection changed. Refresh Winnr before reply setup.')
   if (!Array.isArray(smtp.mailboxes) || !observed.capabilities) throw new Error('Reply setup observations are unverified.')
   setSetup(observed); setMailboxes(smtp.mailboxes); setWebhookId(observed.configuration?.webhookId ?? '')
  } catch (failure) { if (request === generation.current) setError(failure instanceof Error ? failure.message : 'Reply setup is unavailable.') }
  finally { if (request === generation.current) setLoading(false) }
 }, [matches])
 useEffect(() => { void refresh(); return invalidate }, [refresh, invalidate])
 async function act(action: 'prepare' | 'associate' | 'sync', cursor?: string) {
  if (locked.current || !canManage || loading || error || (action !== 'sync' && !canWrite) || (action === 'associate' && !webhookId.trim()) || (action === 'sync' && (!setup?.configuration?.configured || !mailboxes.some(item => item.providerMailboxId === mailboxId)))) return
  locked.current = true; setBusy(true); setNotice(null); const request = generation.current
  try {
   if (action === 'sync') {
    const result = await read<Sync>('/api/inbox/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedConnectionId: connectionId, expectedConnectionVersion: connectionVersion, mailboxId, ...(cursor ? { cursor } : {}) }) })
    if (request !== generation.current) return
    if (![result.saved, result.hydrated, result.bodyUnavailable, result.bodyPending].every(value => Number.isInteger(value) && value >= 0) || typeof result.bodyReady !== 'boolean') throw new Error('Sync result is unverified. Refresh observations.')
    setSync(result)
   } else {
    const result = await read<Configuration>('/api/outreach/ingestion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, expectedConnectionId: connectionId, expectedConnectionVersion: connectionVersion, ...(action === 'associate' ? { webhookId: webhookId.trim() } : {}) }) })
    if (request !== generation.current) return
    if (!result.endpointId || !result.callbackUrl.startsWith('https://')) throw new Error('Webhook setup result is unverified.')
    setNotice(action === 'prepare' ? 'Callback prepared. Create the endpoint in Winnr, then associate its existing ID.' : 'Webhook association saved. Live callback delivery is not yet measured.')
    await refresh()
   }
  } catch (failure) { if (request === generation.current) setError(failure instanceof Error ? failure.message : 'Operation outcome is unverified. Refresh before continuing.') }
  finally { locked.current = false; setBusy(false) }
 }
 return <Card>
  <CardHeader><CardTitle>Reply-receiving setup</CardTitle><CardDescription>Save incoming receipt metadata and stop follow-ups before retrieving message bodies. Provider endpoint creation is manual.</CardDescription></CardHeader>
  <CardContent className="space-y-4">
   {loading && <p role="status">Reading reply configuration…</p>}
   {error && <p role="alert" className="text-destructive">{error}</p>}
   {notice && <p role="status">{notice}</p>}
   {setup && <>
    <p>Webhook association: {setup.configuration?.configured ? 'Configured' : 'Not configured'}. Live receipt delivery: Unknown.</p>
    {setup.configuration && <div className="rounded-lg border p-4 space-y-2"><p className="text-sm font-medium">Winnr callback URL</p><code className="block break-all text-sm">{setup.configuration.callbackUrl}</code><p className="text-sm">Create an enabled endpoint in Winnr with exactly these subscriptions:</p><ul className="list-disc pl-5">{events.map(event => <li key={event}><code>{event}</code></li>)}</ul><p className="text-xs text-muted-foreground">Enabling email.received enables Winnr inbox sync. Do not add wildcard or extra subscriptions. Signing secrets stay on the server.</p></div>}
   </>}
   {!canManage ? <p>Only owners and admins can configure reply receiving or sync inbox pages.</p> : setup && <>
    {canWrite ? <div className="space-y-3"><Button variant="outline" disabled={busy || loading || Boolean(error)} onClick={() => void act('prepare')}>Prepare callback URL</Button><div className="space-y-1"><Label htmlFor="ingestion-webhook">Existing Winnr webhook ID</Label><Input id="ingestion-webhook" value={webhookId} onChange={event => setWebhookId(event.target.value)} maxLength={998} disabled={busy} /></div><Button disabled={busy || loading || Boolean(error) || !webhookId.trim() || !setup.configuration} onClick={() => void act('associate')}>Associate existing webhook</Button></div> : <p>A Winnr token with write permission is required for webhook setup.</p>}
    {setup.capabilities.manualSync && <div className="space-y-3 border-t pt-4"><Label htmlFor="ingestion-mailbox">Mailbox to sync</Label><select id="ingestion-mailbox" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={mailboxId} disabled={busy} onChange={event => { setMailboxId(event.target.value); setSync(null) }}><option value="">Choose an imported SMTP mailbox</option>{mailboxes.map(item => <option key={item.providerMailboxId} value={item.providerMailboxId}>{item.email}</option>)}</select><Button disabled={busy || loading || Boolean(error) || !mailboxId || !setup.configuration?.configured} onClick={() => void act('sync')}>Sync one inbox page</Button>
     {sync && <div role="status" className="space-y-1 text-sm"><p>Saved receipts: {sync.saved} · Bodies retrieved: {sync.hydrated}</p><p>Bodies pending: {sync.bodyPending} · Bodies unavailable on this pass: {sync.bodyUnavailable}</p><p>{sync.bodyReady ? 'Observed bodies are ready for this mailbox.' : 'Receipts are saved; body processing is still incomplete.'} This does not prove all provider history is synced.</p>{sync.nextCursor && <Button variant="outline" disabled={busy} onClick={() => void act('sync', sync.nextCursor ?? undefined)}>Sync next inbox page</Button>}</div>}
    </div>}
   </>}
   <Button variant="outline" disabled={busy || loading} onClick={() => void refresh()}>Refresh reply observations</Button>
  </CardContent>
 </Card>
}
