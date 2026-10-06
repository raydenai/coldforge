'use client'

/**
 * Lead validation dashboard.
 *
 * Shows the provider configuration state, the owned lead list with
 * provenance, a single-lead provider validation action, and a bounded
 * attributed-report import. It deliberately keeps measured verdicts distinct
 * from an explicit `unknown` and from a value that was never measured, and it
 * never loops provider calls over the audience.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  campaignBlockReason,
  parseImportedReport,
  provenanceLabel,
  type ValidationStatus,
} from '@/lib/outreach/validation'
import type { OutstandingOperation, ValidationLead, ValidationSummary } from '@/lib/outreach/validation-database'

interface ProviderResult {
  operationId: string
  state: 'reserved' | 'completed' | 'held_unknown' | 'failed'
  validationStatus: ValidationStatus | null
  outcome?: string | null
  replayed: boolean
}

interface LoadState {
  loading: boolean
  error: string | null
  configured: boolean
  leads: ValidationLead[]
  outstanding: OutstandingOperation[]
  summary: ValidationSummary | null
}

const SELECTED_LEAD_KEY = 'lead-validation:selected-lead'

const emptyState: LoadState = { loading: true, error: null, configured: false, leads: [], outstanding: [], summary: null }

export function ValidationContent() {
  const [state, setState] = useState<LoadState>(emptyState)
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    try {
      return window.sessionStorage.getItem(SELECTED_LEAD_KEY)
    } catch {
      return null
    }
  })
  const [operationId, setOperationId] = useState<string>(() => crypto.randomUUID())
  const [validating, setValidating] = useState(false)
  const [result, setResult] = useState<ProviderResult | null>(null)
  const [warning, setWarning] = useState<string | null>(null)

  const [reportSource, setReportSource] = useState('')
  const [reportedAt, setReportedAt] = useState('')
  const [reportText, setReportText] = useState('')
  const [attested, setAttested] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importMessage, setImportMessage] = useState<string | null>(null)
  const [importErrors, setImportErrors] = useState<string[]>([])

  const load = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true, error: null }))
    try {
      const response = await fetch('/api/leads/validation', { cache: 'no-store' })
      const body = (await response.json()) as Partial<{ provider: { configured: boolean }; leads: ValidationLead[]; outstanding: OutstandingOperation[]; summary: ValidationSummary; error: { message?: string } }>
      if (!response.ok) {
        setState((prev) => ({ ...prev, loading: false, error: body.error?.message ?? 'Could not load validation status.' }))
        return
      }
      setState({
        loading: false,
        error: null,
        configured: body.provider?.configured === true,
        leads: body.leads ?? [],
        outstanding: body.outstanding ?? [],
        summary: body.summary ?? null,
      })
    } catch {
      setState((prev) => ({ ...prev, loading: false, error: 'Could not load validation status.' }))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const selectedLead = useMemo(
    () => state.leads.find((lead) => lead.id === selectedLeadId) ?? null,
    [state.leads, selectedLeadId]
  )

  // The server is the source of truth for a pending attempt: on load/reload a
  // lead with an outstanding reserved/held_unknown operation reuses that exact
  // operation UUID instead of minting a fresh (and potentially re-charging) one.
  useEffect(() => {
    if (!selectedLead) return
    const pending = state.outstanding.find((operation) => operation.leadId === selectedLead.id && operation.email === selectedLead.email.trim().toLowerCase())
    setOperationId(pending ? pending.operationId : crypto.randomUUID())
  }, [selectedLead, state.outstanding])

  const selectLead = useCallback(
    (leadId: string) => {
      setSelectedLeadId(leadId)
      const email = state.leads.find((lead) => lead.id === leadId)?.email.trim().toLowerCase()
      const pending = state.outstanding.find((operation) => operation.leadId === leadId && operation.email === email)
      setOperationId(pending ? pending.operationId : crypto.randomUUID())
      setResult(null)
      setWarning(null)
      try {
        window.sessionStorage.setItem(SELECTED_LEAD_KEY, leadId)
      } catch {
        // Session storage is an optimization only; the server state is canonical.
      }
    },
    [state.leads, state.outstanding]
  )

  const validate = useCallback(async () => {
    if (!selectedLead || validating) return
    // Resolve from the current server observation at the click boundary too:
    // a click can arrive before the selection effect has synchronized its UUID.
    const pending = state.outstanding.find((operation) => operation.leadId === selectedLead.id && operation.email === selectedLead.email.trim().toLowerCase())
    const currentOperationId = pending?.operationId ?? (state.outstanding.some((operation) => operation.operationId === operationId) ? crypto.randomUUID() : operationId)
    setOperationId(currentOperationId)
    setValidating(true)
    setWarning(null)
    try {
      const response = await fetch('/api/leads/validation/provider', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ leadId: selectedLead.id, operationId: currentOperationId }),
      })
      const body = (await response.json()) as { result?: ProviderResult; warning?: string; error?: { message?: string } }
      if (!response.ok || !body.result) {
        // A reconciliation/in-flight failure keeps this operation UUID: the
        // server reservation must be resumed, not bypassed with a new one.
        setWarning(body.error?.message ?? 'Validation could not be completed.')
        await load()
        return
      }
      setResult(body.result)
      setWarning(body.warning ?? null)
      // Reuse the same operation UUID for an unknown hold or an in-flight
      // reserved attempt so the client can never re-charge; only a settled
      // completed/failed result starts a fresh operation.
      if (body.result.state === 'completed' || body.result.state === 'failed') {
        setOperationId(crypto.randomUUID())
      }
      await load()
    } catch {
      setWarning('Validation could not be completed.')
    } finally {
      setValidating(false)
    }
  }, [selectedLead, validating, operationId, load, state.outstanding])

  const importReport = useCallback(async () => {
    if (importing) return
    setImportErrors([])
    setImportMessage(null)
    if (!reportSource.trim()) {
      setImportErrors(['Enter the report source or provider name.'])
      return
    }
    if (!reportedAt || Number.isNaN(Date.parse(reportedAt))) {
      setImportErrors(['Enter the report date.'])
      return
    }
    if (!attested) {
      setImportErrors(['You must attest that this is a genuine external report.'])
      return
    }
    const parsed = parseImportedReport(reportText)
    if (parsed.rows.length === 0) {
      setImportErrors(parsed.errors.length ? parsed.errors : ['Add at least one email and status.'])
      return
    }
    const byEmail = new Map(state.leads.map((lead) => [lead.email.trim().toLowerCase(), lead.id]))
    const rows = []
    const unmatched: string[] = []
    for (const row of parsed.rows) {
      const leadId = byEmail.get(row.email)
      if (!leadId) {
        unmatched.push(`${row.email} is not an owned lead.`)
        continue
      }
      rows.push({ leadId, operationId: crypto.randomUUID(), status: row.status, reference: row.reference })
    }
    if (rows.length === 0) {
      setImportErrors([...parsed.errors, ...unmatched])
      return
    }

    setImporting(true)
    try {
      const response = await fetch('/api/leads/validation/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: reportSource.trim(),
          reportedAt: new Date(reportedAt).toISOString(),
          attested: true,
          rows,
        }),
      })
      const body = (await response.json()) as { imported?: number; failed?: number; error?: { message?: string } }
      if (!response.ok) {
        setImportErrors([body.error?.message ?? 'The report could not be imported.'])
        return
      }
      setImportMessage(`Imported ${body.imported ?? 0} row(s); ${body.failed ?? 0} rejected.`)
      setImportErrors([...parsed.errors, ...unmatched])
      setReportText('')
      await load()
    } catch {
      setImportErrors(['The report could not be imported.'])
    } finally {
      setImporting(false)
    }
  }, [importing, reportSource, reportedAt, attested, reportText, state.leads, load])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Lead validation</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Provider receipts and owner-attested imports are tracked separately from import and syntax. Only a matching
          provider receipt claims ZeroBounce verification.
        </p>
      </div>

      {state.error && (
        <div className="rounded-lg border p-4" role="alert">
          <p className="text-sm font-medium">Could not load validation status</p>
          <p className="text-sm text-muted-foreground mt-1">{state.error}</p>
          <button type="button" className="mt-3 rounded border px-3 py-1.5 text-sm" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      {!state.error && !state.configured && (
        <div className="rounded-lg border p-4" role="status">
          <p className="text-sm font-medium">ZeroBounce is not configured</p>
          <p className="text-sm text-muted-foreground mt-1">
            Paid provider validation is unavailable. You can still import an explicitly attributed report and it will be
            labeled as imported, never as a provider receipt.
          </p>
        </div>
      )}

      {state.summary && (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ['Measured verdicts', state.summary.measured],
            ['Explicitly unknown', state.summary.explicitUnknown],
            ['Never measured', state.summary.unchecked],
            ['Invalid', state.summary.invalid],
          ].map(([label, value]) => (
            <div key={String(label)} className="rounded-lg border p-3">
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="text-xl font-semibold">{value}</dd>
            </div>
          ))}
        </dl>
      )}

      <section className="space-y-4 rounded-lg border p-4">
        <h2 className="font-medium">Validate a lead</h2>
        <label className="block text-sm">
          <span className="text-muted-foreground">Lead</span>
          <select
            className="mt-1 w-full rounded border bg-transparent px-3 py-2 text-sm"
            value={selectedLeadId ?? ''}
            onChange={(event) => selectLead(event.target.value)}
            aria-label="Lead"
          >
            <option value="">Select a lead…</option>
            {state.leads.map((lead) => (
              <option key={lead.id} value={lead.id}>
                {lead.email} {lead.validationStatus ? `— ${lead.validationStatus}` : '— never measured'}
              </option>
            ))}
          </select>
        </label>

        {selectedLead && (
          <div className="rounded border p-3 text-sm space-y-1">
            <p>
              <span className="text-muted-foreground">Status:</span> {selectedLead.validationStatus ?? 'never measured'}
            </p>
            <p>
              <span className="text-muted-foreground">Provenance:</span>{' '}
              {selectedLead.provenance ? provenanceLabel(selectedLead.provenance.verificationLevel) : 'No recorded provenance'}
            </p>
            {selectedLead.validationStatus && (
              <p className="text-muted-foreground">{campaignBlockReason(selectedLead.validationStatus)}</p>
            )}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            type="button"
            className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
            disabled={!selectedLead || !state.configured || validating}
            onClick={() => void validate()}
          >
            {validating ? 'Validating…' : 'Validate with ZeroBounce'}
          </button>
          {result?.state === 'held_unknown' && (
            <span className="text-sm text-muted-foreground">
              Held as unknown. Reusing this attempt will not call the provider again.
            </span>
          )}
          {result?.state === 'reserved' && (
            <span className="text-sm text-muted-foreground">
              This attempt is already in flight and was not re-sent to the provider.
            </span>
          )}
        </div>

        {result && (
          <div className="rounded border p-3 text-sm" role="status">
            <p className="font-medium">Result: {result.validationStatus ?? 'none'}</p>
            {result.outcome && <p className="text-muted-foreground">Detail: {result.outcome}</p>}
            {result.replayed && <p className="text-muted-foreground">This operation was already settled; no new provider call was made.</p>}
            {result.validationStatus && <p className="text-muted-foreground">{campaignBlockReason(result.validationStatus)}</p>}
          </div>
        )}
        {warning && (
          <p className="text-sm text-muted-foreground" role="alert">
            {warning}
          </p>
        )}
      </section>

      <section className="space-y-4 rounded-lg border p-4">
        <h2 className="font-medium">Import an external validation report</h2>
        <p className="text-sm text-muted-foreground">
          Imported rows are recorded as owner-attested imports. They never claim a ZeroBounce receipt and cannot
          downgrade an existing invalid or risky verdict.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="text-muted-foreground">Source / provider</span>
            <input
              className="mt-1 w-full rounded border bg-transparent px-3 py-2 text-sm"
              value={reportSource}
              maxLength={100}
              onChange={(event) => setReportSource(event.target.value)}
              placeholder="e.g. NeverBounce export"
            />
          </label>
          <label className="block text-sm">
            <span className="text-muted-foreground">Report date</span>
            <input
              type="date"
              className="mt-1 w-full rounded border bg-transparent px-3 py-2 text-sm"
              value={reportedAt}
              onChange={(event) => setReportedAt(event.target.value)}
            />
          </label>
        </div>
        <label className="block text-sm">
          <span className="text-muted-foreground">Report rows (CSV email,status[,reference] or JSON array)</span>
          <textarea
            className="mt-1 h-32 w-full rounded border bg-transparent px-3 py-2 font-mono text-xs"
            value={reportText}
            onChange={(event) => setReportText(event.target.value)}
            placeholder={'lead@example.com,valid,receipt-1\nother@example.com,invalid'}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={attested} onChange={(event) => setAttested(event.target.checked)} />
          I attest this is a genuine external validation report attributable to the stated source.
        </label>
        <button
          type="button"
          className="rounded border px-4 py-2 text-sm disabled:opacity-50"
          disabled={importing}
          onClick={() => void importReport()}
        >
          {importing ? 'Importing…' : 'Import report'}
        </button>
        {importMessage && (
          <p className="text-sm" role="status">
            {importMessage}
          </p>
        )}
        {importErrors.length > 0 && (
          <ul className="list-disc pl-5 text-sm text-muted-foreground" role="alert">
            {importErrors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
