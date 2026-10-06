'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { DownstreamRead } from '@/lib/outreach/downstream/core'

const PROVIDERS = [
  { key: 'ghl', label: 'GoHighLevel (CRM & calendar)', fields: [['locationId', 'Location ID'], ['pipelineId', 'Pipeline ID']] },
  { key: 'closebot', label: 'CloseBot (qualification bridge)', fields: [['sourceId', 'Source ID'], ['inboundTokenHeader', 'Inbound token header']] },
  { key: 'retell', label: 'Retell (requested callbacks)', fields: [['fromNumber', 'From number (E.164)']] },
] as const

type ProviderKey = (typeof PROVIDERS)[number]['key']
type Connection = DownstreamRead['connections'][number]
type Appointment = DownstreamRead['appointments'][number]
type Eligibility = DownstreamRead['eligibility'][number]
type Callback = DownstreamRead['callbacks'][number]
type Bridge = DownstreamRead['bridge'][number]

interface LeadOption {
  id: string
  email: string | null
  first_name: string | null
  last_name: string | null
  phone: string | null
}
interface ThreadOption {
  id: string
  leadId: string | null
  subject: string
  participantEmail: string
  participantName: string | null
}
interface CalendarOption {
  id: string
  name: string
  slotDurationMinutes: number | null
}
interface SlotOption {
  startAt: string
  endAt: string | null
}
interface FormState {
  credential: string
  inboundToken: string
  config: Record<string, string>
}
interface ActionResult {
  blocked: boolean
  message: string
}

const emptyForm = (): FormState => ({ credential: '', inboundToken: '', config: {} })
const emptyForms = (): Record<ProviderKey, FormState> => ({ ghl: emptyForm(), closebot: emptyForm(), retell: emptyForm() })

async function postDownstream(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch('/api/outreach/downstream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>
  return { ...payload, __ok: response.ok }
}

function describeActionResult(payload: Record<string, unknown>): ActionResult {
  const ok = payload.__ok === true
  const reason = typeof payload.reason === 'string' ? payload.reason.replace(/_/g, ' ') : null
  const status = typeof payload.status === 'string' ? payload.status : null
  const detail =
    (typeof payload.error === 'object' && payload.error !== null ? String((payload.error as Record<string, unknown>).message) : null) ??
    reason ??
    status ??
    (ok ? 'Done' : 'Request was not accepted')
  return { blocked: !ok, message: detail }
}

function formatTime(value: string | null): string {
  if (!value) return 'Unknown time'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

export default function PipelineContent() {
  const [read, setRead] = useState<DownstreamRead | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [forms, setForms] = useState<Record<ProviderKey, FormState>>(emptyForms())
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<ActionResult | null>(null)

  const [leads, setLeads] = useState<LeadOption[] | null>(null)
  const [threads, setThreads] = useState<ThreadOption[] | null>(null)
  const [referenceError, setReferenceError] = useState<string | null>(null)
  const [selectedLeadId, setSelectedLeadId] = useState('')
  const [selectedThreadId, setSelectedThreadId] = useState('')

  const [calendars, setCalendars] = useState<CalendarOption[]>([])
  const [calendarId, setCalendarId] = useState('')
  const [slotDate, setSlotDate] = useState('')
  const [slots, setSlots] = useState<SlotOption[] | null>(null)
  const [selectedSlot, setSelectedSlot] = useState('')
  const [slotsLoading, setSlotsLoading] = useState(false)
  const slotGeneration = useRef(0)
  const resetAvailability = () => { slotGeneration.current += 1; setSlots(null); setSelectedSlot(''); setSlotsLoading(false); setNotice(null) }

  const [qualification, setQualification] = useState({ criteriaRevision: '1', outcome: 'qualified', evidence: '', attributedSource: 'operator' })
  const [criteria, setCriteria] = useState('')
  const [eligibility, setEligibility] = useState({
    phoneE164: '',
    timezone: 'UTC',
    windowStartHour: '9',
    windowEndHour: '17',
    expiresAt: '',
    maxCalls: '1',
    consentBasis: '',
    evidence: '',
  })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const response = await fetch('/api/outreach/downstream')
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>
        const message = typeof payload.error === 'object' && payload.error !== null ? String((payload.error as Record<string, unknown>).message) : 'Downstream status is unavailable'
        throw new Error(message)
      }
      const next = (await response.json()) as DownstreamRead
      setRead(next)
      setLoadError(null)
      setForms((current) => {
        const updated = emptyForms()
        for (const provider of PROVIDERS) {
          const existing = next.connections.find((entry) => entry.provider === provider.key)
          updated[provider.key] = {
            credential: '',
            inboundToken: '',
            config: Object.fromEntries(provider.fields.map(([field]) => [field, typeof existing?.config[field] === 'string' ? String(existing.config[field]) : ''])),
          }
        }
        void current
        return updated
      })
    } catch (error) {
      setRead(null)
      setLoadError(error instanceof Error ? error.message : 'Downstream status is unavailable')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadReferences = useCallback(async () => {
    try {
      const [leadsResponse, threadsResponse] = await Promise.all([fetch('/api/leads?limit=50'), fetch('/api/inbox?limit=50')])
      if (!leadsResponse.ok || !threadsResponse.ok) throw new Error('Contact and conversation lists are unavailable')
      const leadsPayload = (await leadsResponse.json()) as { leads?: LeadOption[] }
      const threadsPayload = (await threadsResponse.json()) as { threads?: ThreadOption[] }
      setLeads(leadsPayload.leads ?? [])
      setThreads(threadsPayload.threads ?? [])
      setReferenceError(null)
    } catch (error) {
      setLeads(null)
      setThreads(null)
      setReferenceError(error instanceof Error ? error.message : 'Contact and conversation lists are unavailable')
    }
  }, [])

  useEffect(() => {
    void load()
    void loadReferences()
  }, [load, loadReferences])

  const connection = (provider: ProviderKey): Connection | undefined => read?.connections.find((entry) => entry.provider === provider)

  const run = async (key: string, action: () => Promise<Record<string, unknown>>) => {
    setBusy(key)
    setNotice(null)
    try {
      const payload = await action()
      setNotice(describeActionResult(payload))
      if (payload.__ok === true) {
        // A successful save clears every credential input so a secret is never
        // left in the browser; stored config is preserved on reload.
        if (key.endsWith(':save')) {
          setForms((current) => ({ ...current, [key.split(':')[0] as ProviderKey]: { ...current[key.split(':')[0] as ProviderKey], credential: '', inboundToken: '' } }))
        }
        await load()
      }
    } catch (error) {
      setNotice({ blocked: true, message: error instanceof Error ? error.message : 'Action failed' })
    } finally {
      setBusy(null)
    }
  }

  const save = (provider: ProviderKey) => {
    const form = forms[provider]
    const credential = provider === 'closebot' ? { token: form.credential, inboundToken: form.inboundToken } : form.credential
    const hasCredential = provider === 'closebot' ? Boolean(form.credential || form.inboundToken) : Boolean(form.credential)
    return run(`${provider}:save`, () =>
      postDownstream({
        action: 'saveConnection',
        provider,
        expectedRevision: connection(provider)?.revision ?? 0,
        ...(hasCredential ? { credential } : {}),
        config: form.config,
      }),
    )
  }

  const setEnabled = (provider: ProviderKey, enabled: boolean) =>
    run(`${provider}:enable`, () => postDownstream({ action: 'setEnabled', provider, expectedRevision: connection(provider)?.revision ?? 1, enabled }))

  const check = (provider: ProviderKey) =>
    run(`${provider}:check`, () => postDownstream({ action: 'check', provider, expectedRevision: connection(provider)?.revision ?? 1 }))

  const listCalendars = () =>
    run('calendars', async () => {
      const payload = await postDownstream({ action: 'listCalendars' })
      if (payload.__ok === true && Array.isArray(payload.calendars)) {
        setCalendars(payload.calendars as CalendarOption[])
        setNotice({ blocked: false, message: `Found ${(payload.calendars as CalendarOption[]).length} calendar(s)` })
      }
      return payload
    })

  const loadSlots = async () => {
    const generation = ++slotGeneration.current
    setSlotsLoading(true)
    setSlots(null)
    setSelectedSlot('')
    setNotice(null)
    try {
      const start = slotDate ? new Date(`${slotDate}T00:00:00Z`) : new Date()
      const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
      const payload = await postDownstream({
        action: 'listSlots',
        calendarId,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
        timezone: 'UTC',
      })
      if (generation !== slotGeneration.current) return
      if (payload.__ok === true && Array.isArray(payload.slots)) {
        setSlots(payload.slots as SlotOption[])
        setNotice({ blocked: false, message: `${(payload.slots as SlotOption[]).length} returned slot(s)` })
      } else {
        setNotice(describeActionResult(payload))
      }
    } catch (error) {
      if (generation === slotGeneration.current) setNotice({ blocked: true, message: error instanceof Error ? error.message : 'Availability is unavailable' })
    } finally {
      if (generation === slotGeneration.current) setSlotsLoading(false)
    }
  }

  const requestAppointment = () =>
    run('book', async () => {
      const thread = threads?.find((entry) => entry.id === selectedThreadId)
      const payload = await postDownstream({
        action: 'requestAppointment',
        leadId: selectedLeadId,
        ...(thread?.id ? { threadId: thread.id } : {}),
        calendarId,
        startAt: selectedSlot,
        timezone: 'UTC',
      })
      return payload
    })

  const reschedule = (appointment: Appointment) =>
    run(`${appointment.id}:reschedule`, () =>
      postDownstream({ action: 'rescheduleAppointment', appointmentId: appointment.id, startAt: selectedSlot, timezone: 'UTC' }),
    )

  const cancel = (appointment: Appointment) =>
    run(`${appointment.id}:cancel`, () => postDownstream({ action: 'cancelAppointment', appointmentId: appointment.id }))

  const recordEligibility = () =>
    run('eligibility', () =>
      postDownstream({
        action: 'recordEligibility',
        leadId: selectedLeadId,
        phoneE164: eligibility.phoneE164 || selectedLead?.phone || '',
        timezone: eligibility.timezone,
        windowStartHour: Number(eligibility.windowStartHour),
        windowEndHour: Number(eligibility.windowEndHour),
        expiresAt: new Date(eligibility.expiresAt).toISOString(),
        maxCalls: Number(eligibility.maxCalls),
        consentBasis: eligibility.consentBasis,
        evidence: eligibility.evidence,
      }),
    )

  const revokeEligibility = (entry: Eligibility) =>
    run(`${entry.id}:revoke`, () => postDownstream({ action: 'revokeEligibility', eligibilityId: entry.id, expectedRevision: entry.revision }))

  const requestCallback = (entry: Eligibility) => run(`${entry.id}:callback`, () => postDownstream({ action: 'initiateCallback', eligibilityId: entry.id }))

  const recordQualification = () =>
    run('qualify', () =>
      postDownstream({
        action: 'qualify',
        leadId: selectedLeadId,
        ...(selectedThreadId ? { threadId: selectedThreadId } : {}),
        criteriaRevision: Number(qualification.criteriaRevision),
        criteria: criteria.trim() ? { notes: criteria.trim() } : {},
        outcome: qualification.outcome,
        evidence: qualification.evidence,
        attributedSource: qualification.attributedSource,
      }),
    )

  const reviewProposal = (bridge: Bridge, decision: 'taken_over' | 'dismissed') =>
    run(`${bridge.id}:review`, () => postDownstream({ action: 'reviewBridge', bridgeId: bridge.id, decision }))

  const selectedLead = useMemo(() => leads?.find((lead) => lead.id === selectedLeadId) ?? null, [leads, selectedLeadId])

  if (loading) {
    return (
      <div className="space-y-6 p-6">
        <h1 className="text-2xl font-semibold">Pipeline &amp; bookings</h1>
        <p role="status" className="text-sm text-muted-foreground">Loading downstream status…</p>
      </div>
    )
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Pipeline &amp; bookings</h1>
        <p className="text-sm text-muted-foreground">
          Configure CRM, calendar and voice providers, qualify conversations, book confirmed appointments and request eligible callbacks. A saved configuration is never a verified connection until a read-only check succeeds.
        </p>
      </div>

      {loadError ? (
        <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          Downstream status is unavailable: {loadError}
        </div>
      ) : null}
      {notice ? (
        <div role={notice.blocked ? 'alert' : 'status'} className={`rounded-md border px-3 py-2 text-sm ${notice.blocked ? 'border-destructive/40 bg-destructive/10' : 'border-border bg-muted/40'}`}>
          {notice.message}
        </div>
      ) : null}
      {read?.masterStop ? <div className="rounded-md border border-destructive/40 px-3 py-2 text-sm">Master outbound stop is active. Calls are blocked at the final grant.</div> : null}

      {read === null && !loadError ? (
        <p className="text-sm text-muted-foreground">Downstream data is unknown/unavailable.</p>
      ) : null}

      {read ? (
        <>
          {referenceError ? <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">{referenceError}</div> : null}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Contact &amp; conversation</CardTitle>
              <CardDescription>Select a real lead and thread. No internal identifier is typed by hand.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="lead-select">Contact</Label>
                <select id="lead-select" className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm" value={selectedLeadId} onChange={(event) => { setSelectedLeadId(event.target.value); setSelectedThreadId(''); setEligibility((current) => ({...current,phoneE164:'',consentBasis:'',evidence:'',expiresAt:''})) }}>
                  <option value="">{leads === null ? 'Contacts unavailable' : 'Select a contact'}</option>
                  {(leads ?? []).map((lead) => (
                    <option key={lead.id} value={lead.id}>
                      {[lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.email || lead.id}
                      {lead.email ? ` · ${lead.email}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="thread-select">Conversation</Label>
                <select id="thread-select" className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm" value={selectedThreadId} onChange={(event) => setSelectedThreadId(event.target.value)}>
                  <option value="">{threads === null ? 'Conversations unavailable' : 'Select a conversation'}</option>
                  {(threads ?? []).filter((thread) => !selectedLeadId || thread.leadId === selectedLeadId).map((thread) => (
                    <option key={thread.id} value={thread.id}>
                      {thread.participantName ?? thread.participantEmail} · {thread.subject}
                    </option>
                  ))}
                </select>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 md:grid-cols-3">
            {PROVIDERS.map((provider) => {
              const existing = connection(provider.key)
              const unsupported = existing?.capability.readOnlyCheck === 'unsupported'
              return (
                <Card key={provider.key}>
                  <CardHeader>
                    <CardTitle className="text-base">{provider.label}</CardTitle>
                    <CardDescription>
                      {existing?.configured ? 'Credential stored' : 'Not configured'} · {existing?.enabled ? 'Enabled' : 'Disabled'}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex flex-wrap gap-1">
                      <Badge variant={existing?.enabled ? 'default' : 'secondary'}>{existing?.enabled ? 'enabled' : 'disabled'}</Badge>
                      <Badge variant={existing?.verifiedAt ? 'default' : 'outline'}>{existing?.verifiedAt ? 'verified' : 'unverified'}</Badge>
                      {unsupported ? <Badge variant="outline">read-only check unsupported</Badge> : null}
                    </div>
                    {provider.fields.map(([field, label]) => (
                      <div key={field} className="space-y-1">
                        <Label htmlFor={`${provider.key}-${field}`}>{label}</Label>
                        <Input
                          id={`${provider.key}-${field}`}
                          value={forms[provider.key].config[field] ?? ''}
                          onChange={(event) =>
                            setForms((current) => ({
                              ...current,
                              [provider.key]: { ...current[provider.key], config: { ...current[provider.key].config, [field]: event.target.value } },
                            }))
                          }
                        />
                      </div>
                    ))}
                    <div className="space-y-1">
                      <Label htmlFor={`${provider.key}-credential`}>{provider.key === 'closebot' ? 'API key' : 'Credential'}</Label>
                      <Input
                        id={`${provider.key}-credential`}
                        type="password"
                        autoComplete="off"
                        placeholder={existing?.configured ? 'Stored (leave blank to keep)' : 'API token'}
                        value={forms[provider.key].credential}
                        onChange={(event) => setForms((current) => ({ ...current, [provider.key]: { ...current[provider.key], credential: event.target.value } }))}
                      />
                    </div>
                    {provider.key === 'closebot' ? (
                      <div className="space-y-1">
                        <Label htmlFor="closebot-inbound-token">Inbound callback token</Label>
                        <Input
                          id="closebot-inbound-token"
                          type="password"
                          autoComplete="off"
                          placeholder={existing?.configured ? 'Stored (leave blank to keep)' : 'Callback token'}
                          value={forms.closebot.inboundToken}
                          onChange={(event) => setForms((current) => ({ ...current, closebot: { ...current.closebot, inboundToken: event.target.value } }))}
                        />
                        <p className="text-xs text-muted-foreground">Encrypted as credential material; never returned to the browser.</p>
                      </div>
                    ) : null}
                    <p className="text-xs text-muted-foreground">Stored encrypted. Never returned to the browser.</p>
                    {existing?.lastCheckDetail ? <p className="text-xs text-muted-foreground">Last check: {String(existing.lastCheckDetail).replace(/_/g, ' ')}</p> : null}
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" disabled={busy !== null} onClick={() => void save(provider.key)}>
                        Save
                      </Button>
                      <Button size="sm" variant="outline" disabled={busy !== null || !existing} onClick={() => void check(provider.key)}>
                        Check
                      </Button>
                      <Button
                        size="sm"
                        variant={existing?.enabled ? 'destructive' : 'secondary'}
                        disabled={busy !== null || !existing?.configured}
                        onClick={() => void setEnabled(provider.key, !existing?.enabled)}
                      >
                        {existing?.enabled ? 'Disable' : 'Enable'}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Book an appointment</CardTitle>
              <CardDescription>A selected slot is re-checked with the provider, reserved durably, then written once. Duration comes from the verified calendar, never synthesized.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap items-end gap-2">
                <Button size="sm" variant="outline" disabled={busy !== null || !connection('ghl')?.enabled} onClick={() => void listCalendars()}>
                  Load calendars
                </Button>
                <div className="space-y-1">
                  <Label htmlFor="calendar-select">Calendar</Label>
                  <select id="calendar-select" className="h-9 rounded-md border border-input bg-transparent px-3 text-sm" value={calendarId} onChange={(event) => { resetAvailability(); setCalendarId(event.target.value) }}>
                    <option value="">{calendars.length ? 'Select a calendar' : 'No calendars loaded'}</option>
                    {calendars.map((calendar) => (
                      <option key={calendar.id} value={calendar.id}>
                        {calendar.name}
                        {calendar.slotDurationMinutes ? ` · ${calendar.slotDurationMinutes} min` : ' · duration unknown'}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="slot-date">Date (UTC)</Label>
                  <Input id="slot-date" type="date" value={slotDate} onChange={(event) => { resetAvailability(); setSlotDate(event.target.value) }} />
                </div>
                <Button size="sm" disabled={busy !== null || !calendarId} onClick={() => void loadSlots()}>
                  Load availability
                </Button>
              </div>
              {slotsLoading ? <p role="status" className="text-sm text-muted-foreground">Loading availability…</p> : null}
              {slots !== null ? (
                slots.length ? (
                  <div className="flex flex-wrap gap-1">
                    {slots.map((slot) => (
                      <Button key={slot.startAt} size="sm" variant={selectedSlot === slot.startAt ? 'default' : 'outline'} onClick={() => setSelectedSlot(slot.startAt)}>
                        {formatTime(slot.startAt)}
                      </Button>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No availability returned for that date.</p>
                )
              ) : null}
              <Button size="sm" disabled={busy !== null || !selectedLeadId || !calendarId || !selectedSlot} onClick={() => void requestAppointment()}>
                Request appointment
              </Button>

              <div className="space-y-2 pt-2">
                {read.appointments.length ? (
                  read.appointments.map((appointment) => (
                    <div key={appointment.id} className="flex flex-wrap items-center justify-between gap-2 border-b py-2 text-sm">
                      <span>
                        {formatTime(appointment.starts_at)} · {appointment.calendar_id}
                        {appointment.provider_appointment_id ? ` · ${appointment.provider_appointment_id}` : ''}
                      </span>
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">{appointment.status}</Badge>
                        <Button size="sm" variant="outline" disabled={busy !== null || !selectedSlot || calendarId !== appointment.calendar_id || !['scheduled','rescheduled'].includes(appointment.status) || !appointment.provider_appointment_id} onClick={() => void reschedule(appointment)}>
                          Reschedule to selected
                        </Button>
                        <Button size="sm" variant="destructive" disabled={busy !== null || !['scheduled','rescheduled'].includes(appointment.status) || !appointment.provider_appointment_id} onClick={() => void cancel(appointment)}>
                          Cancel
                        </Button>
                      </span>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">No appointments recorded.</p>
                )}
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Requested callbacks</CardTitle>
                <CardDescription>Explicit owner-recorded eligibility only. Email interest never authorizes a call.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="elig-phone">Phone (E.164)</Label>
                    <Input id="elig-phone" value={eligibility.phoneE164 || (selectedLead?.phone ?? '')} onChange={(event) => setEligibility((current) => ({ ...current, phoneE164: event.target.value }))} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="elig-tz">Time zone (IANA)</Label>
                    <Input id="elig-tz" value={eligibility.timezone} onChange={(event) => setEligibility((current) => ({ ...current, timezone: event.target.value }))} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="elig-start">Window start hour</Label>
                    <Input id="elig-start" type="number" min={0} max={23} value={eligibility.windowStartHour} onChange={(event) => setEligibility((current) => ({ ...current, windowStartHour: event.target.value }))} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="elig-end">Window end hour</Label>
                    <Input id="elig-end" type="number" min={1} max={24} value={eligibility.windowEndHour} onChange={(event) => setEligibility((current) => ({ ...current, windowEndHour: event.target.value }))} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="elig-expiry">Expires at (your local time)</Label>
                    <Input id="elig-expiry" type="datetime-local" value={eligibility.expiresAt} onChange={(event) => setEligibility((current) => ({ ...current, expiresAt: event.target.value }))} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="elig-max">Max calls</Label>
                    <Input id="elig-max" type="number" min={1} max={10} value={eligibility.maxCalls} onChange={(event) => setEligibility((current) => ({ ...current, maxCalls: event.target.value }))} />
                  </div>
                  <div className="space-y-1 sm:col-span-2">
                    <Label htmlFor="elig-basis">Consent basis</Label>
                    <Input id="elig-basis" value={eligibility.consentBasis} onChange={(event) => setEligibility((current) => ({ ...current, consentBasis: event.target.value }))} />
                  </div>
                  <div className="space-y-1 sm:col-span-2">
                    <Label htmlFor="elig-evidence">Evidence of consent</Label>
                    <Input id="elig-evidence" value={eligibility.evidence} onChange={(event) => setEligibility((current) => ({ ...current, evidence: event.target.value }))} />
                  </div>
                </div>
                <Button size="sm" disabled={busy !== null || !selectedLeadId || !(eligibility.phoneE164 || selectedLead?.phone) || !eligibility.expiresAt || !eligibility.consentBasis || !eligibility.evidence} onClick={() => void recordEligibility()}>
                  Record eligibility
                </Button>

                <div className="space-y-2">
                  {read.eligibility.length ? (
                    read.eligibility.map((entry) => (
                      <div key={entry.id} className="flex flex-wrap items-center justify-between gap-2 border-b py-2 text-sm">
                        <span>
                          {entry.phone_e164} · {entry.timezone} · {entry.window_start_hour}:00–{entry.window_end_hour}:00 · {entry.calls_started}/{entry.max_calls} calls
                        </span>
                        <span className="flex items-center gap-2">
                          <Badge variant={entry.revoked_at ? 'secondary' : 'outline'}>{entry.revoked_at ? 'revoked' : 'active'}</Badge>
                          <Button size="sm" disabled={busy !== null || Boolean(entry.revoked_at)} onClick={() => void requestCallback(entry)}>
                            Request callback
                          </Button>
                          <Button size="sm" variant="outline" disabled={busy !== null || Boolean(entry.revoked_at)} onClick={() => void revokeEligibility(entry)}>
                            Revoke
                          </Button>
                        </span>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">No eligibility recorded.</p>
                  )}
                </div>

                <div className="space-y-2 pt-2">
                  <p className="text-sm font-medium">Callback history &amp; holds</p>
                  {read.callbacks.length ? (
                    read.callbacks.map((callback: Callback) => (
                      <div key={callback.id} className="flex items-center justify-between border-b py-1 text-sm">
                        <span>
                          {callback.phone_e164} · {formatTime(callback.created_at)}
                          {callback.provider_call_id ? ` · ${callback.provider_call_id}` : ''}
                        </span>
                        <Badge variant={callback.status === 'unknown' ? 'destructive' : 'outline'}>{callback.status === 'unknown' ? 'held (unknown)' : callback.status}</Badge>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">No callbacks requested.</p>
                  )}
                </div>
              </CardContent>
            </Card>

            <div className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Qualification</CardTitle>
                  <CardDescription>Explicit criteria, evidence and outcome. A provider classification alone is never treated as qualified.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="space-y-1">
                      <Label htmlFor="criteria-rev">Criteria revision</Label>
                      <Input id="criteria-rev" type="number" min={1} value={qualification.criteriaRevision} onChange={(event) => setQualification((current) => ({ ...current, criteriaRevision: event.target.value }))} />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="outcome">Outcome</Label>
                      <select id="outcome" className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm" value={qualification.outcome} onChange={(event) => setQualification((current) => ({ ...current, outcome: event.target.value }))}>
                        <option value="qualified">Qualified</option>
                        <option value="disqualified">Disqualified</option>
                        <option value="unknown">Unknown</option>
                      </select>
                    </div>
                    <div className="space-y-1 sm:col-span-2">
                      <Label htmlFor="criteria-notes">Criteria</Label>
                      <Input id="criteria-notes" value={criteria} onChange={(event) => setCriteria(event.target.value)} />
                    </div>
                    <div className="space-y-1 sm:col-span-2">
                      <Label htmlFor="qual-evidence">Evidence</Label>
                      <Input id="qual-evidence" value={qualification.evidence} onChange={(event) => setQualification((current) => ({ ...current, evidence: event.target.value }))} />
                    </div>
                    <div className="space-y-1 sm:col-span-2">
                      <Label htmlFor="qual-source">Attributed source</Label>
                      <Input id="qual-source" value={qualification.attributedSource} onChange={(event) => setQualification((current) => ({ ...current, attributedSource: event.target.value }))} />
                    </div>
                  </div>
                  <Button size="sm" disabled={busy !== null || !selectedLeadId || !qualification.evidence} onClick={() => void recordQualification()}>
                    Record qualification
                  </Button>
                  <div className="space-y-1 pt-2">
                    {read.qualifications.length ? (
                      read.qualifications.slice(0, 5).map((entry) => (
                        <div key={entry.id} className="flex items-center justify-between border-b py-1 text-sm">
                          <span>{formatTime(entry.created_at)} · {entry.attributed_source}</span>
                          <Badge variant="outline">{entry.outcome}</Badge>
                        </div>
                      ))
                    ) : (
                      <p className="text-sm text-muted-foreground">No qualification records.</p>
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">CloseBot proposals</CardTitle>
                  <CardDescription>Review or take over. Replies are sent through the shared inbox reply flow, never auto-sent from here.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {read.bridge.length ? (
                    read.bridge.map((bridge) => (
                      <div key={bridge.id} className="space-y-1 border-b py-2 text-sm">
                        <div className="flex items-center justify-between">
                          <span>{bridge.direction} · {formatTime(bridge.created_at)}</span>
                          <Badge variant={bridge.status === 'taken_over' ? 'default' : 'outline'}>{bridge.status}</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">{JSON.stringify(bridge.proposal).slice(0, 240)}</p>
                        <div className="flex flex-wrap gap-2">
                          <Button size="sm" variant="outline" disabled={busy !== null || Boolean(bridge.review)} onClick={() => void reviewProposal(bridge, 'taken_over')}>
                            Take over
                          </Button>
                          <Button size="sm" variant="ghost" disabled={busy !== null || Boolean(bridge.review)} onClick={() => void reviewProposal(bridge, 'dismissed')}>
                            Dismiss
                          </Button>
                          {bridge.thread_id ? (
                            <a className="text-xs underline" href={`/inbox?thread=${bridge.thread_id}`}>
                              Open conversation
                            </a>
                          ) : null}
                        </div>
                      </div>
                    ))
                  ) : (
                    <p className="text-sm text-muted-foreground">No CloseBot proposals recorded.</p>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}
