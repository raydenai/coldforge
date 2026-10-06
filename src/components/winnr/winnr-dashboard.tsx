'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { SmtpSetup } from './smtp-setup'
import { IngestionSetup } from './ingestion-setup'
import type { CursorPage, Domain, InboxMessage, Mailbox, WinnrAccount, WarmingMailbox, WarmingPage } from '@/lib/winnr/types'

interface Connection { id: string; version: number; account: WinnrAccount; connectedAt: string; verifiedAt: string }
interface ConnectionState { connection: Connection | null; canManage: boolean }
type Tab = 'mailboxes' | 'warming' | 'domains' | 'inbox'
type Action = 'enable' | 'pause' | 'resume'
interface Observation { observedAt: string; connectionId: string; connectionVersion: number }
type Page = Observation & (CursorPage<Mailbox | Domain | InboxMessage> | WarmingPage)
interface ApiErrorBody { error?: { code: string; message: string; outcomeUnknown?: boolean; operationId?: string } }
class ApiError extends Error {
  constructor(readonly detail: NonNullable<ApiErrorBody['error']>) { super(detail.message) }
}
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init })
  const body: unknown = await response.json()
  if (!response.ok) throw new ApiError((body as ApiErrorBody).error ?? { code: 'request_failed', message: 'Request failed. Data remains unverified.' })
  return body as T
}
const display = (value: string | number | null | undefined) => value ?? 'Unknown'
const timestamp = (value: string | null) => value ? new Date(value).toLocaleString() : 'Unknown'
const buttonStyle = 'rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed'
const panelStyle = 'rounded-xl border border-border bg-card p-5'

export function WinnrDashboard() {
  const [accountState, setAccountState] = useState<ConnectionState | null>(null)
  const [connectionLoading, setConnectionLoading] = useState(true)
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [token, setToken] = useState('')
  const [showSetup, setShowSetup] = useState(false)
  const [tab, setTab] = useState<Tab>('mailboxes')
  const [cursorHistory, setCursorHistory] = useState<(string | null)[]>([null])
  const [warmingPage, setWarmingPage] = useState(1)
  const [data, setData] = useState<Page | null>(null)
  const [dataError, setDataError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<{ id: string; email: string; action: Action } | 'disconnect' | null>(null)
  const [paid, setPaid] = useState(false)
  const [holds, setHolds] = useState<Record<string, string>>({})
  const mutationLock = useRef(false)
  const connectionRequest = useRef(0)
  const connectionRef = useRef<Connection | null>(null)
  const connection = accountState?.connection ?? null
  const canWrite = Boolean(accountState?.canManage && connection?.account.permissions.includes('write'))
  const cursor = cursorHistory[cursorHistory.length - 1]

  const loadConnection = useCallback(async (signal?: AbortSignal) => {
    const generation = ++connectionRequest.current
    setConnectionLoading(true); setConfirmation(null); setPaid(false)
    connectionRef.current = null
    try {
      const state = await request<ConnectionState>('/api/winnr/connection', { signal })
      if (signal?.aborted || generation !== connectionRequest.current) return
      connectionRef.current = state.connection
      setAccountState(state)
      setConnectionError(null)
      setData(null)
      setCursorHistory([null]); setWarmingPage(1)
    } catch (error) {
      if (!signal?.aborted && generation === connectionRequest.current) setConnectionError(error instanceof ApiError ? error.message : 'Connection could not be verified. Refresh to check again.')
    } finally { if (!signal?.aborted && generation === connectionRequest.current) setConnectionLoading(false) }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    void loadConnection(controller.signal)
    return () => controller.abort()
  }, [loadConnection])

  useEffect(() => {
    if (!connection || connectionError) return
    const controller = new AbortController()
    let current = true
    setLoading(true); setData(null); setDataError(null)
    const query = tab === 'warming' ? `page=${warmingPage}&perPage=25` : `limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    request<Page>(`/api/winnr/${tab}?${query}`, { signal: controller.signal }).then(result => {
      if (!current || controller.signal.aborted) return
      if (result.connectionId !== connectionRef.current?.id || result.connectionVersion !== connectionRef.current?.version) {
        setDataError('The account changed during this read. Refresh the connection before continuing.')
        return
      }
      setData(result)
    }).catch(error => {
      if (current && !controller.signal.aborted) setDataError(error instanceof ApiError ? error.message : 'Provider data could not be verified. Refresh to check again.')
    }).finally(() => { if (current) setLoading(false) })
    return () => { current = false; controller.abort() }
  }, [connection, connectionError, tab, cursor, warmingPage, refresh])

  async function manageConnection(disconnect: boolean) {
    if (mutationLock.current || connectionLoading || !accountState?.canManage || connectionError) return
    mutationLock.current = true; setBusy(true); setNotice(null)
    try {
      const result = await request<ConnectionState>('/api/winnr/connection', {
        method: disconnect ? 'DELETE' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(disconnect
          ? { expectedConnectionId: connection?.id, expectedVersion: connection?.version }
          : { token, expectedConnectionId: connection?.id ?? null, expectedVersion: connection?.version ?? null }),
      })
      ++connectionRequest.current
      connectionRef.current = result.connection
      setAccountState(result); setConnectionError(null); setToken(''); setConfirmation(null)
      setData(null); setCursorHistory([null]); setWarmingPage(1)
      setNotice(disconnect ? 'Account disconnected.' : 'Account verified and connected.')
    } catch (error) {
      setNotice(error instanceof ApiError ? error.message : 'Connection change could not be verified. Refresh the connection before another attempt.')
      if (!(error instanceof ApiError)) setConnectionError('Connection change outcome is unverified. Refresh the connection.')
    } finally { mutationLock.current = false; setBusy(false) }
  }

  async function mutateWarming() {
    if (!confirmation || confirmation === 'disconnect' || !connection || !canWrite || connectionLoading || connectionError || mutationLock.current) return
    if (confirmation.action === 'enable' && !paid) return
    const target = confirmation
    const holdKey = `${connection.id}:${target.id}`
    if (holds[holdKey]) return
    mutationLock.current = true; setBusy(true); setNotice(null)
    const operationId = crypto.randomUUID()
    try {
      const result = await request<{ operation: { id: string; status: string } }>('/api/winnr/warming', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          action: target.action, connectionId: connection.id, connectionVersion: connection.version,
          operationId, mailboxIds: [target.id], ...(target.action === 'enable' ? { confirmPaid: true } : {}),
        }),
      })
      if (result.operation?.status !== 'succeeded') throw new Error('Unverified operation result')
      setNotice('Operation accepted. Refreshing the provider state.'); setRefresh(value => value + 1)
    } catch (error) {
      const unknown = !(error instanceof ApiError) || error.detail.outcomeUnknown === true
      if (unknown) {
        const reference = error instanceof ApiError ? error.detail.operationId ?? operationId : operationId
        setHolds(previous => ({ ...previous, [holdKey]: reference }))
        setNotice(`Outcome unknown. Operation ${reference} requires reconciliation; do not resubmit.`)
      } else setNotice(error.message)
    } finally { setConfirmation(null); setPaid(false); mutationLock.current = false; setBusy(false) }
  }

  function chooseTab(value: Tab) { setTab(value); setData(null); setCursorHistory([null]); setWarmingPage(1) }
  function actionButton(item: Mailbox | WarmingMailbox, action: Action) {
    const reference = connection && holds[`${connection.id}:${item.id}`]
    return <div className="space-y-2">
      {canWrite && <button className={buttonStyle} disabled={busy || connectionLoading || Boolean(reference) || Boolean(connectionError) || Boolean(dataError)} onClick={() => { setConfirmation({ id: item.id, email: item.email, action }); setPaid(false) }}>{action === 'enable' ? 'Enable warming' : action === 'pause' ? 'Pause warming' : 'Resume warming'}</button>}
      {reference && <p className="text-xs text-amber-500">Reconciliation required: {reference}</p>}
    </div>
  }

  return <main className="mx-auto max-w-7xl space-y-6 p-4 md:p-8">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><p className="text-xs uppercase tracking-widest text-muted-foreground">Email infrastructure</p><h1 className="mt-1 text-3xl font-semibold">Winnr</h1><p className="mt-2 text-muted-foreground">Mailboxes, warming, domains and replies from your connected account.</p></div>
      <button className={buttonStyle} disabled={busy || connectionLoading} onClick={() => void loadConnection()}>Refresh connection</button>
    </header>
    {connectionError && <div role="alert" className={`${panelStyle} text-destructive`}>{connectionError}</div>}
    {notice && <div role="status" className={panelStyle}>{notice}</div>}
    <section aria-label="Winnr connection" className={panelStyle}>
      {connectionError ? <p>Connection unverified</p> : !accountState ? <p>Checking connection…</p> : connection ? <div className="flex flex-wrap justify-between gap-4">
        <div><h2 className="text-lg font-semibold">{connection.account.name}</h2><p className="text-sm text-muted-foreground">Plan: {display(connection.account.plan)} · Verified: {timestamp(connection.verifiedAt)}</p><p className="mt-1 text-xs text-muted-foreground">Permissions: {connection.account.permissions.join(', ') || 'None'}</p></div>
        {accountState?.canManage && <button className={buttonStyle} disabled={busy || connectionLoading || Boolean(connectionError)} onClick={() => setConfirmation('disconnect')}>Disconnect account</button>}
      </div> : <div><h2 className="text-lg font-semibold">No account connected</h2><p className="mt-1 text-muted-foreground">Connect an existing account or <a className="underline" href="https://app.winnr.app/signup" target="_blank" rel="noopener noreferrer">create a Winnr account</a>.</p></div>}
      {accountState?.canManage && <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={event => { event.preventDefault(); void manageConnection(false) }}>
        <label className="flex min-w-60 flex-1 flex-col gap-1 text-sm">API token<input type="password" autoComplete="off" spellCheck={false} value={token} onChange={event => setToken(event.target.value)} className="rounded-lg border border-border bg-background px-3 py-2" /></label>
        <button className={buttonStyle} disabled={busy || connectionLoading || !token.trim() || Boolean(connectionError)} type="submit">{connection ? 'Replace connection' : 'Connect account'}</button>
        <a className="pb-2 text-sm underline text-muted-foreground" href="https://winnr.app/help/api-mcp/api-tokens.html" target="_blank" rel="noopener noreferrer">Find your API token</a>
      </form>}
      {accountState && !accountState.canManage && <p className="mt-3 text-sm text-muted-foreground">Only organization owners and admins can manage this connection.</p>}
      {connection && !connection.account.permissions.includes('write') && <p className="mt-3 text-sm text-muted-foreground">This token is read-only. Warming controls require write permission.</p>}
    </section>
    {connection && !connectionLoading && !connectionError && <section className="space-y-4"><button className={buttonStyle} aria-expanded={showSetup} onClick={() => setShowSetup(value => !value)}>SMTP and reply setup</button>{showSetup && <><SmtpSetup key={`smtp:${connection.id}:${connection.version}`} connectionId={connection.id} connectionVersion={connection.version} canManage={Boolean(accountState?.canManage)} canWrite={canWrite} /><IngestionSetup key={`ingestion:${connection.id}:${connection.version}`} connectionId={connection.id} connectionVersion={connection.version} canManage={Boolean(accountState?.canManage)} canWrite={canWrite} /></>}</section>}
    {confirmation && <section role="dialog" aria-label="Confirm account action" className={`${panelStyle} border-amber-500/50 space-y-4`}>
      {confirmation === 'disconnect' ? <><h2 className="font-semibold">Disconnect account?</h2><p>Disconnecting removes this connection. It does not stop warming or cancel Winnr billing.</p><button className={buttonStyle} disabled={busy} onClick={() => void manageConnection(true)}>Confirm disconnect</button></> : <>
        <h2 className="font-semibold">{confirmation.action === 'enable' ? 'Enable' : confirmation.action === 'pause' ? 'Pause' : 'Resume'} warming for {confirmation.email}?</h2>
        {confirmation.action === 'enable' ? <><p>$0.60 per mailbox per month, charged upfront and recurring. Pausing warming or disconnecting does not cancel billing.</p><p className="text-sm text-muted-foreground">Settings: 10 emails/day, 30% response rate, slow ramp enabled.</p><label className="flex items-start gap-2"><input type="checkbox" checked={paid} onChange={event => setPaid(event.target.checked)} className="mt-1" />I authorize the recurring warming charge for this mailbox.</label></> : <p>Pausing or disconnecting does not cancel billing. This action changes the provider warming state.</p>}
        <button className={buttonStyle} disabled={busy || (confirmation.action === 'enable' && !paid)} onClick={() => void mutateWarming()}>Confirm {confirmation.action}</button>
      </>}
      <button className={`${buttonStyle} ml-2`} disabled={busy} onClick={() => { setConfirmation(null); setPaid(false) }}>Cancel</button>
    </section>}
    {connection && !connectionLoading && !connectionError && <section className={panelStyle}>
      <div className="flex flex-wrap justify-between gap-3 border-b border-border pb-4"><div role="tablist" aria-label="Infrastructure views" className="flex flex-wrap gap-2">{(['mailboxes', 'warming', 'domains', 'inbox'] as const).map(value => <button key={value} role="tab" aria-selected={tab === value} className={`${buttonStyle} ${tab === value ? 'bg-primary/10 text-primary' : ''}`} onClick={() => chooseTab(value)}>{value.charAt(0).toUpperCase() + value.slice(1)}</button>)}</div><button className={buttonStyle} disabled={loading || busy} onClick={() => setRefresh(value => value + 1)}>Refresh view</button></div>
      <div role="tabpanel" className="mt-4 space-y-4">
        {loading && <p role="status">Loading provider data…</p>}
        {dataError && <p role="alert" className="text-destructive">{dataError}</p>}
        {data && <><p className="text-xs text-muted-foreground">Observed: {timestamp(data.observedAt)} · {data.items.length} on this page{ 'total' in data ? ` · Total: ${display(data.total)}` : ''}</p>
          {data.items.length === 0 && <p>No {tab} returned on this page.</p>}
          <div className="grid gap-3">{data.items.map(item => <article key={item.id} className="rounded-lg border border-border p-4">
            {'email' in item && <div className="flex flex-wrap justify-between gap-3"><div><h3 className="font-medium">{item.email}</h3><p className="text-sm text-muted-foreground">Provider state: {item.status}</p>{'dailyLimit' in item ? <p className="text-sm">Daily limit: {display(item.dailyLimit)}</p> : <><p className="text-sm">Health: {display(item.healthScore)} · Sent: {display(item.sent)} · Replies: {display(item.replies)}</p><p className="text-xs text-muted-foreground">Last synced: {timestamp(item.lastSyncedAt)}</p></>}</div>{'dailyLimit' in item ? actionButton(item, 'enable') : item.status === 'paused' ? actionButton(item, 'resume') : item.status === 'disabled' ? actionButton(item, 'enable') : item.status === 'active' ? actionButton(item, 'pause') : null}</div>}
            {'dnsHealth' in item && <><h3 className="font-medium">{item.name}</h3><p className="text-sm">Provider state: {item.status} · DNS: {display(item.dnsHealth)}</p><p className="text-xs text-muted-foreground">Checked: {timestamp(item.checkedAt)}</p></>}
            {'preview' in item && <><h3 className="font-medium">{item.subject || '(No subject)'}</h3><p className="text-xs text-muted-foreground">From: {item.from} · To: {item.to} · {timestamp(item.receivedAt)}</p><p className="mt-3 whitespace-pre-wrap break-words text-sm">{item.preview}</p></>}
          </article>)}</div>
          <nav aria-label="Page navigation" className="flex items-center gap-3"><button className={buttonStyle} disabled={loading || (tab === 'warming' ? warmingPage <= 1 : cursorHistory.length <= 1)} onClick={() => tab === 'warming' ? setWarmingPage(value => value - 1) : setCursorHistory(value => value.slice(0, -1))}>Previous page</button><span className="text-sm text-muted-foreground">Page {tab === 'warming' ? warmingPage : cursorHistory.length}</span><button className={buttonStyle} disabled={loading || !data.hasMore || (tab !== 'warming' && (!('nextCursor' in data) || !data.nextCursor))} onClick={() => { if (tab === 'warming') setWarmingPage(value => value + 1); else if ('nextCursor' in data && data.nextCursor) { const nextCursor = data.nextCursor; setCursorHistory(value => [...value, nextCursor]) } }}>Next page</button></nav>
        </>}
      </div>
    </section>}
  </main>
}
