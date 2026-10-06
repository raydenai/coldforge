'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, BadgeCheck, Ban, Clock, Pause, Play, RefreshCw, ShieldAlert, Zap } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { OperationsReadiness, OperationsStatus } from '@/lib/outreach/operations/core'

interface OperationsView {
  status: OperationsStatus
  readiness: OperationsReadiness
}

interface TickResult {
  result: string
  phase?: string
  status?: string
  reason?: string
  modelCalls?: number
  smtpAttempts?: number
}

type ControlAction = 'enable' | 'disable' | 'pause' | 'resume' | 'stop' | 'resumeStop'

function relative(timestamp: string | null | undefined): string {
  if (!timestamp) return 'never'
  const then = Date.parse(timestamp)
  if (Number.isNaN(then)) return 'unknown'
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

function errorMessage(payload: unknown, fallback: string): string {
  const parsed = payload as { error?: { message?: string } } | null
  return parsed?.error?.message ?? fallback
}

export function OperationsContent() {
  const [view, setView] = useState<OperationsView | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const mounted = useRef(true)
  const busyRef = useRef<string | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/outreach/operations', { cache: 'no-store' })
      const payload: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        if (mounted.current) {
          setUnavailable(errorMessage(payload, 'Operations status unavailable'))
          setView(null)
        }
        return
      }
      if (mounted.current) {
        setView(payload as OperationsView)
        setUnavailable(null)
      }
    } catch {
      if (mounted.current) {
        setUnavailable('Operations status unavailable')
        setView(null)
      }
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const control = useCallback(
    async (action: ControlAction) => {
      if (!view || busyRef.current) return
      busyRef.current = action
      setBusy(action)
      setNotice(null)
      try {
        const response = await fetch('/api/outreach/operations', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, expectedRevision: view.status.control.revision }),
        })
        const payload: unknown = await response.json().catch(() => null)
        if (!response.ok) {
          setNotice(errorMessage(payload, 'Automation change was not accepted'))
          if (response.status === 409) await load()
          return
        }
        setNotice(`Automation ${action} accepted`)
        await load()
      } catch {
        setNotice('Automation change was not accepted')
      } finally {
        busyRef.current = null
        if (mounted.current) setBusy(null)
      }
    },
    [load, view],
  )

  const tick = useCallback(async () => {
    if (!view || busyRef.current) return
    busyRef.current = 'tick'
    setBusy('tick')
    setNotice(null)
    try {
      const response = await fetch('/api/outreach/operations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'tick' }),
      })
      const payload: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        setNotice(errorMessage(payload, 'Manual tick was not accepted'))
        if (response.status === 409) await load()
        return
      }
      const tickResult = (payload as { tick?: TickResult } | null)?.tick
      setNotice(
        tickResult
          ? `Manual tick ${tickResult.result}${tickResult.phase ? ` (${tickResult.phase})` : ''}${tickResult.reason ? `: ${tickResult.reason}` : ''}`
          : 'Manual tick accepted',
      )
      await load()
    } catch {
      setNotice('Manual tick was not accepted')
    } finally {
      busyRef.current = null
      if (mounted.current) setBusy(null)
    }
  }, [load, view])

  if (unavailable) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Operations</h1>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" /> Operations unavailable
            </CardTitle>
            <CardDescription>{unavailable}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => void load()} variant="outline">
              <RefreshCw className="mr-2 h-4 w-4" /> Retry operations read
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (!view) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold">Operations</h1>
        <div className="h-40 animate-pulse rounded-lg bg-muted" />
      </div>
    )
  }

  const { control: state, heartbeat, stats, attention, runs } = view.status
  const { readiness } = view

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Operations</h1>
          <p className="text-sm text-muted-foreground">Daily outreach, recent activity and email safety controls.</p>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={busy !== null}>
          <RefreshCw className="mr-2 h-4 w-4" /> Refresh
        </Button>
      </div>

      {notice ? (
        <div role="status" className="rounded-md border border-border bg-muted px-4 py-2 text-sm">
          {notice}
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5" /> Automation
          </CardTitle>
          <CardDescription>When enabled, the schedule checks one outreach task at a time.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Badge variant={state.automationEnabled ? 'default' : 'secondary'}>
              {state.automationEnabled ? 'Automation enabled' : 'Automation disabled'}
            </Badge>
            <Badge variant={state.schedulerPaused ? 'destructive' : 'outline'}>
              {state.schedulerPaused ? 'Scheduler paused' : 'Scheduler running'}
            </Badge>
            <Badge variant={state.masterStop ? 'destructive' : 'outline'}>
              {state.masterStop ? 'Master outbound stop ON' : 'Outbound allowed'}
            </Badge>
          </div>
          <div className="flex flex-wrap gap-2">
            {state.automationEnabled ? (
              <Button variant="outline" onClick={() => void control('disable')} disabled={busy !== null}>
                Disable automation
              </Button>
            ) : (
              <Button onClick={() => void control('enable')} disabled={busy !== null || !readiness.ready}>
                Enable automation
              </Button>
            )}
            {state.schedulerPaused ? (
              <Button variant="outline" onClick={() => void control('resume')} disabled={busy !== null}>
                <Play className="mr-2 h-4 w-4" /> Resume scheduler
              </Button>
            ) : (
              <Button variant="outline" onClick={() => void control('pause')} disabled={busy !== null}>
                <Pause className="mr-2 h-4 w-4" /> Pause scheduler
              </Button>
            )}
            {state.masterStop ? (
              <Button variant="outline" onClick={() => void control('resumeStop')} disabled={busy !== null}>
                Resume outbound
              </Button>
            ) : (
              <Button variant="destructive" onClick={() => void control('stop')} disabled={busy !== null}>
                <Ban className="mr-2 h-4 w-4" /> Stop all outbound
              </Button>
            )}
            <Button variant="secondary" onClick={() => void tick()} disabled={busy !== null}>
              Run one tick
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Pausing stops the scheduler from claiming new work. The master outbound stop additionally refuses every new campaign,
            manual and agent send at the shared send gate; in-flight unknown outcomes stay held and are never resent automatically.
          </p>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5" /> Schedule activity
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>Last attempt: {relative(heartbeat.lastAttemptAt)}</p>
            <p>Last success: {relative(heartbeat.lastSuccessAt)}</p>
            <p>Last task: {({body:'Sync message content',campaign:'Campaign email',decision:'Conversation review',reply:'Approved reply'})[heartbeat.lastAttemptPhase ?? ''] ?? 'None'}</p>
            <p>Last status: {heartbeat.lastAttemptStatus ?? 'none'}</p>
            <p>Detail: {(heartbeat.lastAttemptDetail ?? 'none').replaceAll('_',' ')}</p>
            <p>Consecutive failures: {heartbeat.consecutiveFailures}</p>
            <p className="text-xs text-muted-foreground">
              The schedule needs an enabled deployment and valid scheduler configuration. Activity appears only after a task has been recorded; these timestamps do not prove email delivery.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <BadgeCheck className="h-5 w-5" /> Recorded work
            </CardTitle>
            <CardDescription>Counts come from recorded email attempts, model requests and inbox syncs. Mailbox acceptance does not prove delivery.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>SMTP accepted today: {stats.sendsAcceptedToday}</p>
            <p>Accepted attempts: {stats.attemptsAccepted}</p>
            <p>Unknown SMTP outcomes: {stats.attemptsUnknown}</p>
            <p>Reserved attempts: {stats.attemptsReserved}</p>
            <p>Unknown model runs: {stats.agentRunsUnknown}</p>
            <p>Bodies pending: {stats.bodyPending}</p>
            <p>Approved replies pending: {stats.decisionsPending}</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5" /> Readiness
          </CardTitle>
          <CardDescription>
            {readiness.ready
              ? 'Static setup is complete. Provider mailbox availability is revalidated at each send.'
              : 'Enable is blocked until every required input below is configured.'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {readiness.blockers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No readiness blockers recorded.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {readiness.blockers.map((blocker) => (
                <li key={blocker.code} className="flex items-center justify-between gap-4">
                  <span>{blocker.label}</span>
                  <a className="text-primary underline" href={blocker.href}>
                    Open
                  </a>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Attention queue</CardTitle>
          <CardDescription>
            Unconfirmed sends, held tasks and messages awaiting content. Open delivery review to check a held send without resending.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {attention.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing needs attention.</p>
          ) : (
            <div className="space-y-3">
              {attention.map(item => <article key={`${item.kind}:${item.referenceId}`} className="space-y-2 rounded border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2"><strong>{({smtp_unknown:'Unconfirmed email',agent_unknown:'Unconfirmed model request',body_pending:'Message awaiting content',run_held:'Held task'})[item.kind] ?? 'Needs review'}</strong><span className="text-xs text-muted-foreground">{relative(item.observedAt)}</span></div>
                <p className="text-sm">{(item.reason ?? 'Outcome has not been confirmed').replaceAll('_',' ')}</p>
                <Link className="inline-block underline" href={item.kind.includes('smtp') || item.kind.includes('dispatch') ? '/operations/reconciliation' : item.kind.includes('agent') || item.kind.includes('model') ? '/agents' : '/inbox'}>Review</Link>
                <details className="text-xs text-muted-foreground"><summary>Support reference</summary><span className="break-all font-mono">{item.referenceId}</span></details>
              </article>)}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent runs</CardTitle>
          <CardDescription>Recorded tasks, outcomes and external requests.</CardDescription>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <p className="text-sm text-muted-foreground">No scheduler runs recorded yet.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="py-1">Phase</th>
                  <th className="py-1">Status</th>
                  <th className="py-1">Reason</th>
                  <th className="py-1">Model / SMTP</th>
                  <th className="py-1">Started</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-t border-border">
                    <td className="py-1">{run.phase}</td>
                    <td className="py-1">{run.status}</td>
                    <td className="py-1">{run.reason ?? 'none'}</td>
                    <td className="py-1">
                      {run.modelCalls} / {run.smtpAttempts}
                    </td>
                    <td className="py-1">{relative(run.startedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
