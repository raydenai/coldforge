'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

interface Props { connectionId: string; connectionVersion: number; canManage: boolean; canWrite: boolean }
interface Mailbox { id: string; email: string }
interface Status { providerMailboxId: string; email: string; syncedAt: string }
interface Observation { connectionId: string | null; connectionVersion?: number }
interface Page extends Observation { items: Mailbox[]; nextCursor: string | null; hasMore: boolean }
interface SmtpStatus extends Observation { mailboxes: Status[] }
async function read<T>(url: string, init?: RequestInit): Promise<T> {
 const response = await fetch(url, { cache: 'no-store', ...init })
 const data = await response.json()
 if (!response.ok) throw new Error(data.error?.message ?? 'SMTP setup is unavailable. Refresh to verify it.')
 return data as T
}
export function SmtpSetup({ connectionId, connectionVersion, canManage, canWrite }: Props) {
 const [mailboxes, setMailboxes] = useState<Mailbox[]>([])
 const [status, setStatus] = useState<Status[] | null>(null)
 const [cursor, setCursor] = useState<string | null>(null)
 const [selected, setSelected] = useState<string[]>([])
 const [loading, setLoading] = useState(true)
 const [busy, setBusy] = useState(false)
 const [error, setError] = useState<string | null>(null)
 const [notice, setNotice] = useState<string | null>(null)
 const generation = useRef(0), locked = useRef(false)
 const matches = useCallback((value: Observation) => value.connectionId === connectionId && value.connectionVersion === connectionVersion, [connectionId, connectionVersion])
 const invalidate = useCallback(() => { ++generation.current }, [])
 const refresh = useCallback(async () => {
  const request = ++generation.current
  setLoading(true); setError(null); setStatus(null); setSelected([]); setMailboxes([]); setCursor(null)
  try {
   const [smtp, page] = await Promise.all([read<SmtpStatus>('/api/winnr/smtp'), read<Page>('/api/winnr/mailboxes?limit=100')])
   if (request !== generation.current) return
   if (!matches(smtp) || !matches(page)) throw new Error('The connection changed. Refresh the Winnr connection before importing.')
   if (!Array.isArray(smtp.mailboxes) || !Array.isArray(page.items)) throw new Error('SMTP observations are unverified.')
   setStatus(smtp.mailboxes); setMailboxes(page.items); setCursor(page.hasMore ? page.nextCursor : null)
  } catch (failure) { if (request === generation.current) setError(failure instanceof Error ? failure.message : 'SMTP setup is unavailable.') }
  finally { if (request === generation.current) setLoading(false) }
 }, [matches])
 useEffect(() => { void refresh(); return invalidate }, [refresh, invalidate])
 async function more() {
  if (!cursor || loading || busy) return
  const request = generation.current; setLoading(true)
  try {
   const page = await read<Page>(`/api/winnr/mailboxes?limit=100&cursor=${encodeURIComponent(cursor)}`)
   if (request !== generation.current) return
   if (!matches(page)) throw new Error('The connection changed. Refresh the Winnr connection before importing.')
   setMailboxes(previous => [...previous, ...page.items.filter(item => !previous.some(existing => existing.id === item.id))]); setCursor(page.hasMore ? page.nextCursor : null)
  } catch (failure) { if (request === generation.current) setError(failure instanceof Error ? failure.message : 'Mailbox read failed.') }
  finally { if (request === generation.current) setLoading(false) }
 }
 async function sync() {
  if (locked.current || !canManage || !canWrite || loading || error || selected.length === 0) return
  locked.current = true; setBusy(true); setNotice(null)
  const request = generation.current
  try {
   await read('/api/winnr/smtp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedConnectionId: connectionId, expectedConnectionVersion: connectionVersion, mailboxIds: selected }) })
   if (request !== generation.current) return
   setNotice('SMTP credentials imported. Verifying stored metadata.'); await refresh()
  } catch (failure) { if (request === generation.current) setError(failure instanceof Error ? failure.message : 'Import outcome is unverified. Refresh before another import.') }
  finally { locked.current = false; setBusy(false) }
 }
 return <Card>
  <CardHeader><CardTitle>Campaign SMTP setup</CardTitle><CardDescription>Import credentials privately from Winnr for the mailboxes you choose. Passwords remain on the server. Configured credentials do not prove delivery.</CardDescription></CardHeader>
  <CardContent className="space-y-4">
   {loading && <p role="status">Reading SMTP observations…</p>}
   {error && <p role="alert" className="text-destructive">{error}</p>}
   {notice && <p role="status">{notice}</p>}
   {status && <div className="space-y-2">{status.length === 0 ? <p>No SMTP credentials imported.</p> : status.map(item => <p key={item.providerMailboxId} className="break-words text-sm">{item.email} · Configured · Observed {new Date(item.syncedAt).toLocaleString()}</p>)}</div>}
   {!canManage ? <p>Only owners and admins can import SMTP credentials.</p> : !canWrite ? <p>A Winnr token with read and write permissions is required to import SMTP credentials.</p> : !error && <>
    <fieldset className="grid gap-2 sm:grid-cols-2" disabled={busy || loading}><legend className="mb-2 text-sm font-medium">Choose owned mailboxes (up to 100)</legend>{mailboxes.map(mailbox => <label key={mailbox.id} className="flex items-start gap-2 rounded-lg border p-3 text-sm"><input type="checkbox" aria-label={`Import ${mailbox.email}`} checked={selected.includes(mailbox.id)} disabled={!selected.includes(mailbox.id) && selected.length >= 100} onChange={event => setSelected(previous => event.target.checked ? [...previous, mailbox.id] : previous.filter(id => id !== mailbox.id))} /><span className="break-all">{mailbox.email}</span></label>)}</fieldset>
    {cursor && <Button variant="outline" disabled={loading || busy} onClick={() => void more()}>Load more owned mailboxes</Button>}
    <Button disabled={busy || loading || selected.length === 0} onClick={() => void sync()}>Import selected SMTP credentials</Button>
   </>}
   <Button variant="outline" disabled={loading || busy} onClick={() => void refresh()}>Refresh SMTP observations</Button>
  </CardContent>
 </Card>
}
