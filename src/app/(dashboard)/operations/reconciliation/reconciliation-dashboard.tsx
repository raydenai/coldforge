'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { canReconcile, evidenceLabel, formatAge, heldGuidance } from '@/lib/outreach/reconciliation/core'
import type { ReconciliationItem, ReconciliationList, ReconciliationOutcome, ReconciliationStatus } from '@/lib/outreach/reconciliation/schemas'

const ENDPOINT = '/api/outreach/reconciliation'

function EvidenceBadge({ evidence }: { evidence: ReconciliationItem['evidence'] }) {
  const variant = evidence === 'available' ? 'default' : evidence === 'conflicting' ? 'destructive' : 'secondary'
  return <Badge variant={variant}>{evidenceLabel(evidence)}</Badge>
}

function isList(value: ReconciliationList | ReconciliationStatus): value is ReconciliationList {
  return Array.isArray((value as ReconciliationList).items)
}

/**
 * Operator-facing held reconciliation page. It only ever displays persisted
 * identifiers and evidence status: no raw message body, credentials or API keys.
 */
export function ReconciliationDashboard() {
  const [list, setList] = useState<ReconciliationList | null>(null)
  const [status, setStatus] = useState<ReconciliationStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [unavailable, setUnavailable] = useState(false)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const inFlight = useRef(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch(ENDPOINT, { credentials: 'same-origin' })
      if (!response.ok) throw new Error('unavailable')
      const parsed = (await response.json()) as ReconciliationList | ReconciliationStatus
      if (isList(parsed)) {
        setList(parsed)
        setStatus(null)
      } else {
        setStatus(parsed)
        setList(null)
      }
      setUnavailable(false)
    } catch {
      setUnavailable(true)
      setList(null)
      setStatus(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const reconcile = useCallback(
    async (item: Pick<ReconciliationItem, 'attemptId' | 'fingerprint'>) => {
      if (inFlight.current) return
      inFlight.current = true
      setPendingId(item.attemptId)
      setNotice(null)
      try {
        const response = await fetch(ENDPOINT, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ attemptId: item.attemptId, fingerprint: item.fingerprint }),
        })
        if (!response.ok) throw new Error('failed')
        const outcome = (await response.json()) as ReconciliationOutcome
        if (outcome.status === 'accepted') {
          setNotice(outcome.alreadyAccepted ? 'Already recorded as accepted.' : 'Recorded the authenticated relay acceptance. Nothing was sent.')
        } else {
          setNotice(heldGuidance(outcome.reason))
        }
        await load()
      } catch {
        setNotice('Reconciliation could not be completed. No send was attempted.')
      } finally {
        setPendingId(null)
        inFlight.current = false
      }
    },
    [load],
  )

  const counts = list?.counts

  return (
    <div className="space-y-6" data-testid="reconciliation-dashboard">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Delivery review</h1>
          <p className="text-sm text-muted-foreground">
            Check an unconfirmed email using verified Winnr relay evidence. Reviewing evidence does not resend email or restart a campaign.
          </p>
        </div>
        <nav className="flex flex-wrap items-center gap-3 text-sm" aria-label="Reconciliation setup links">
          <Link className="underline" href="/winnr">
            Winnr connections and ingestion
          </Link>
          <Link className="underline" href="/inbox">
            Inbox manual sync
          </Link>
          <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
            Refresh
          </Button>
        </nav>
      </div>

      {unavailable ? (
        <Card>
          <CardContent className="pt-6">
            <p role="alert" className="text-sm text-destructive">
              Reconciliation data is unavailable. Counts and evidence are not shown because no measurement succeeded.
            </p>
          </CardContent>
        </Card>
      ) : null}

      {notice ? (
        <Card>
          <CardContent className="pt-6">
            <p role="status" className="text-sm">
              {notice}
            </p>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Accepted (measured)</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold" data-testid="counts-accepted">
              {counts ? counts.accepted : '—'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Unconfirmed holds</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold" data-testid="counts-unconfirmed">
              {counts ? counts.unconfirmed : '—'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Evidence available</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold" data-testid="counts-available">
              {counts ? counts.available : '—'}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Missing or conflicting</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-semibold" data-testid="counts-unproven">
              {counts ? counts.missing + counts.conflicting : '—'}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Held attempts</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? <p className="text-sm text-muted-foreground">Loading held attempts…</p> : null}
          {!loading && list && list.items.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="empty-held">
              No held attempts require reconciliation.
            </p>
          ) : null}
          <ul className="divide-y" data-testid="held-list">
            {(list?.items ?? []).map((item) => (
              <li key={item.attemptId} className="space-y-2 py-4" data-testid={`held-${item.attemptId}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <EvidenceBadge evidence={item.evidence} />
                  <details className="text-xs text-muted-foreground"><summary>Support reference</summary><span className="break-all font-mono">{item.attemptId}</span></details>
                  <span className="text-xs text-muted-foreground">{item.kind}</span>
                  <span className="text-xs text-muted-foreground">age {formatAge(item.ageSeconds)}</span>
                  <span className="text-xs text-muted-foreground">{item.status}</span>
                </div>
                <div className="flex flex-wrap gap-3 text-sm">
                  <span>
                    To <span className="font-medium">{item.recipient}</span>
                  </span>
                  <span>
                    From <span className="font-medium">{item.sender}</span>
                  </span>
                  {item.campaignId ? (
                    <Link className="underline" href={`/campaigns/${item.campaignId}`}>
                      Campaign
                    </Link>
                  ) : null}
                  {item.threadId ? (
                    <Link className="underline" href={`/inbox?thread=${item.threadId}`}>
                      Conversation
                    </Link>
                  ) : null}
                </div>
                <div className="flex items-center gap-3">
                  <Button
                    type="button"
                    size="sm"
                    disabled={!canReconcile(item) || pendingId === item.attemptId}
                    onClick={() => void reconcile(item)}
                  >
                    {pendingId === item.attemptId ? 'Reconciling…' : 'Reconcile'}
                  </Button>
                  {item.evidence !== 'available' ? (
                    <p className="text-xs text-muted-foreground" data-testid={`guidance-${item.attemptId}`}>
                      {heldGuidance(`evidence_${item.evidence}`)}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {status ? (
        <Card>
          <CardHeader>
            <CardTitle>Attempt status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>{status.reason ? heldGuidance(status.reason) : 'Eligible for reconciliation.'}</p>
            <p className="text-xs text-muted-foreground">Evidence: {evidenceLabel(status.evidence)}</p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Recent reconciliation audit</CardTitle>
        </CardHeader>
        <CardContent>
          {list && list.recent.length > 0 ? (
            <ul className="divide-y text-sm" data-testid="recent-audit">
              {list.recent.map((audit) => (
                <li key={audit.auditId} className="flex flex-wrap items-center gap-2 py-2">
                  <span className="font-mono text-xs">{audit.attemptId}</span>
                  <span className="text-xs text-muted-foreground">{audit.kind}</span>
                  <span className="text-xs text-muted-foreground">by {audit.reconciledBy}</span>
                  <span className="text-xs text-muted-foreground">{audit.providerMessageId}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No reconciliations recorded yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
