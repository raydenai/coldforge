'use client'

import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Clock,
  Mail,
  Shield,
  BarChart3,
  Save,
  AlertCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import { MANDATORY_DELIVERABILITY_SETTINGS } from '@/lib/campaigns/core'

interface CampaignSettingsProps {
  campaignId: string
  settings: Record<string, unknown>
  expectedUpdatedAt: string
  mailboxIds: string[]
  onUpdate: (settings: Record<string, unknown>, updatedAt: string, mailboxIds: string[]) => void
}

interface Settings {
  dailyLimit: number
  sendingDays: number[]
  sendingWindowStart: number
  sendingWindowEnd: number
  timezone: string
  skipWeekends: boolean
  trackOpens: boolean
  trackClicks: boolean
  unsubscribeLink: boolean
  stopOnReply: boolean
  stopOnBounce: boolean
  abTestEnabled: boolean
  abTestWinnerCriteria: 'open_rate' | 'reply_rate' | 'click_rate'
  abTestDuration: number
}

const TIMEZONES = [
  { value: 'America/New_York', label: 'Eastern Time (ET)' },
  { value: 'America/Chicago', label: 'Central Time (CT)' },
  { value: 'America/Denver', label: 'Mountain Time (MT)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
  { value: 'Europe/London', label: 'London (GMT)' },
  { value: 'Europe/Paris', label: 'Paris (CET)' },
  { value: 'Asia/Tokyo', label: 'Tokyo (JST)' },
  { value: 'Asia/Singapore', label: 'Singapore (SGT)' },
  { value: 'Australia/Sydney', label: 'Sydney (AEST)' },
]

const DEFAULT_SETTINGS: Settings = {
  dailyLimit: 50,
  sendingDays: [1, 2, 3, 4, 5],
  sendingWindowStart: 9,
  sendingWindowEnd: 17,
  timezone: 'America/New_York',
  skipWeekends: true,
  trackOpens: false,
  trackClicks: false,
  unsubscribeLink: true,
  stopOnReply: true,
  stopOnBounce: true,
  abTestEnabled: false,
  abTestWinnerCriteria: 'open_rate',
  abTestDuration: 24,
}

export function CampaignSettings({ campaignId, settings: initialSettings, expectedUpdatedAt, mailboxIds: initialMailboxIds, onUpdate }: CampaignSettingsProps) {
  const [settings, setSettings] = useState<Settings>({
    ...DEFAULT_SETTINGS,
    ...(initialSettings as Partial<Settings>),
    // Historical rows may store disabled safety switches; repair them so saving
    // an unrelated setting keeps the required policy true.
    ...MANDATORY_DELIVERABILITY_SETTINGS,
  })
  const [mailboxIds, setMailboxIds] = useState(initialMailboxIds)
  const [mailboxes, setMailboxes] = useState<{ id: string; email: string }[]>([])
  const [mailboxCursor, setMailboxCursor] = useState<string | null>(null)
  const [mailboxError, setMailboxError] = useState<string | null>(null)
  useEffect(() => {
    let mounted = true
    fetch('/api/winnr/mailboxes?limit=100').then(async response => {
      const data = await response.json()
      if (mounted) {
        if (response.ok) { setMailboxes(data.items ?? []); setMailboxCursor(data.nextCursor ?? null) }
        else setMailboxError(data.error?.message ?? 'Mailboxes unavailable')
      }
    }).catch(() => { if (mounted) setMailboxError('Mailboxes unavailable') })
    return () => { mounted = false }
  }, [])
  async function loadMoreMailboxes() {
    if (!mailboxCursor) return
    try {
      const response = await fetch(`/api/winnr/mailboxes?limit=100&cursor=${encodeURIComponent(mailboxCursor)}`)
      const data = await response.json()
      if (!response.ok) { setMailboxError(data.error?.message ?? 'Mailboxes unavailable'); return }
      setMailboxes(previous => [...previous, ...(data.items ?? [])])
      setMailboxCursor(data.nextCursor ?? null)
    } catch { setMailboxError('Mailboxes unavailable') }
  }
  const [saving, setSaving] = useState(false)
  const [hasChanges, setHasChanges] = useState(false)

  function updateSetting<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings(prev => ({ ...prev, [key]: value }))
    setHasChanges(true)
  }

  async function saveSettings() {
    setSaving(true)
    try {
      const response = await fetch(`/api/campaigns/${campaignId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          settings: { ...settings, ...MANDATORY_DELIVERABILITY_SETTINGS },
          mailboxIds,
          expectedUpdatedAt,
        }),
      })

      if (response.ok) {
        const data = await response.json()
        onUpdate(data.campaign.settings, data.campaign.updatedAt, data.campaign.mailboxIds)
        setHasChanges(false)
        toast.success('Settings saved successfully')
      } else {
        const error = await response.json()
        toast.error(error.error?.message || 'Failed to save settings')
      }
    } catch (error) {
      console.error('Failed to save settings:', error)
      toast.error('Failed to save settings')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Save Button */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Campaign Settings</h2>
          <p className="text-sm text-muted-foreground">
            Configure sending limits, tracking, and scheduling
          </p>
        </div>
        <Button onClick={saveSettings} disabled={saving || !hasChanges}>
          <Save className="mr-2 h-4 w-4" />
          {saving ? 'Saving...' : 'Save Settings'}
        </Button>
      </div>

      <Card>
        <CardHeader><CardTitle>Winnr senders</CardTitle><CardDescription>Choose mailboxes from your connected account. Delivery remains blocked until the execution service is ready.</CardDescription></CardHeader>
        <CardContent className="space-y-2">
          {mailboxError && <p role="status">{mailboxError}</p>}
          {mailboxes.map(mailbox => <label key={mailbox.id} className="flex items-center gap-2">
            <input type="checkbox" checked={mailboxIds.includes(mailbox.id)} onChange={event => {
              setMailboxIds(previous => event.target.checked ? [...previous, mailbox.id] : previous.filter(id => id !== mailbox.id))
              setHasChanges(true)
            }} />{mailbox.email}
          </label>)}
          {mailboxCursor && <Button variant="outline" onClick={loadMoreMailboxes}>Load more mailboxes</Button>}
          {!mailboxError && mailboxes.length === 0 && <p>No Winnr mailboxes are available.</p>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Sending days</CardTitle></CardHeader>
        <CardContent className="flex gap-3 flex-wrap">{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day, index) => <label key={day} className="flex gap-1 items-center">
          <input type="checkbox" checked={settings.sendingDays.includes(index)} onChange={event => updateSetting('sendingDays', event.target.checked ? [...settings.sendingDays, index] : settings.sendingDays.filter(value => value !== index))} />{day}
        </label>)}</CardContent>
      </Card>
      {/* Sending Schedule */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Sending Schedule
          </CardTitle>
          <CardDescription>
            Control when emails are sent
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Daily Send Limit</Label>
              <Input
                type="number"
                min="1"
                max="500"
                value={settings.dailyLimit}
                onChange={(e) => updateSetting('dailyLimit', parseInt(e.target.value) || 50)}
              />
              <p className="text-xs text-muted-foreground">
                Maximum emails per day across all mailboxes
              </p>
            </div>

            <div className="space-y-2">
              <Label>Timezone</Label>
              <Select
                value={settings.timezone}
                onValueChange={(value) => updateSetting('timezone', value)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIMEZONES.map((tz) => (
                    <SelectItem key={tz.value} value={tz.value}>
                      {tz.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>Sending Window Start</Label>
              <Select
                value={settings.sendingWindowStart.toString()}
                onValueChange={(value) => updateSetting('sendingWindowStart', parseInt(value))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 24 }, (_, i) => (
                    <SelectItem key={i} value={i.toString()}>
                      {i.toString().padStart(2, '0')}:00
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Sending Window End</Label>
              <Select
                value={settings.sendingWindowEnd.toString()}
                onValueChange={(value) => updateSetting('sendingWindowEnd', parseInt(value))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 24 }, (_, i) => (
                    <SelectItem key={i} value={i.toString()}>
                      {i.toString().padStart(2, '0')}:00
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label>Skip Weekends</Label>
              <p className="text-xs text-muted-foreground">
                Don&apos;t send emails on Saturday and Sunday
              </p>
            </div>
            <Switch
              checked={settings.skipWeekends}
              onCheckedChange={(checked) => updateSetting('skipWeekends', checked)}
            />
          </div>
        </CardContent>
      </Card>

      <p role="status">SMTP campaign sending is available after Winnr credential import, verified leads and sender identity setup in Launch. Open and click tracking and A/B variants remain unavailable.</p>
      {/* Tracking */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5" />
            Tracking & Analytics
          </CardTitle>
          <CardDescription>
            Control what data is tracked
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>Track Opens</Label>
              <p className="text-xs text-muted-foreground">
                Track when recipients open your emails
              </p>
            </div>
            <Switch
              checked={settings.trackOpens}
              disabled
              onCheckedChange={(checked) => updateSetting('trackOpens', checked)}
            />
          </div>

          <Separator />

          <div className="flex items-center justify-between">
            <div>
              <Label>Track Clicks</Label>
              <p className="text-xs text-muted-foreground">
                Track when recipients click links in your emails
              </p>
            </div>
            <Switch
              checked={settings.trackClicks}
              disabled
              onCheckedChange={(checked) => updateSetting('trackClicks', checked)}
            />
          </div>

          <Separator />

          <div className="flex items-center justify-between">
            <div>
              <Label>Include Unsubscribe Link</Label>
              <p className="text-xs text-muted-foreground">
                Add an unsubscribe link to the footer of emails
              </p>
            </div>
            <Switch
              checked={settings.unsubscribeLink}
              disabled
              onCheckedChange={(checked) => updateSetting('unsubscribeLink', checked)}
            />
          </div>
        </CardContent>
      </Card>

      {/* Safety Controls */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Safety Controls
          </CardTitle>
          <CardDescription>
            Automatically stop sequences based on recipient actions
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>Stop on Reply</Label>
              <p className="text-xs text-muted-foreground">
                Stop sending when a lead replies to any email
              </p>
            </div>
            <Switch
              checked={settings.stopOnReply}
              disabled
              onCheckedChange={(checked) => updateSetting('stopOnReply', checked)}
            />
          </div>

          <Separator />

          <div className="flex items-center justify-between">
            <div>
              <Label>Stop on Bounce</Label>
              <p className="text-xs text-muted-foreground">
                Stop sending when an email bounces
              </p>
            </div>
            <Switch
              checked={settings.stopOnBounce}
              disabled
              onCheckedChange={(checked) => updateSetting('stopOnBounce', checked)}
            />
          </div>
        </CardContent>
      </Card>

      {/* A/B Testing */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            A/B Testing
          </CardTitle>
          <CardDescription>
            Test different email variations to optimize performance
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>Enable A/B Testing</Label>
              <p className="text-xs text-muted-foreground">
                Automatically test and select winning variants
              </p>
            </div>
            <Switch
              checked={settings.abTestEnabled}
              disabled
              onCheckedChange={(checked) => updateSetting('abTestEnabled', checked)}
            />
          </div>

          {settings.abTestEnabled && (
            <>
              <Separator />

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Winner Criteria</Label>
                  <Select
                    value={settings.abTestWinnerCriteria}
                    onValueChange={(value: Settings['abTestWinnerCriteria']) =>
                      updateSetting('abTestWinnerCriteria', value)
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="open_rate">Highest Open Rate</SelectItem>
                      <SelectItem value="click_rate">Highest Click Rate</SelectItem>
                      <SelectItem value="reply_rate">Highest Reply Rate</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Test Duration (hours)</Label>
                  <Input
                    type="number"
                    min="1"
                    max="168"
                    value={settings.abTestDuration}
                    onChange={(e) => updateSetting('abTestDuration', parseInt(e.target.value) || 24)}
                  />
                  <p className="text-xs text-muted-foreground">
                    How long to run the test before selecting a winner
                  </p>
                </div>
              </div>

              <div className="rounded-lg bg-blue-50 dark:bg-blue-950 p-4">
                <div className="flex items-start gap-3">
                  <AlertCircle className="h-5 w-5 text-blue-600 mt-0.5" />
                  <div className="text-sm">
                    <p className="font-medium text-blue-900 dark:text-blue-100">
                      How A/B Testing Works
                    </p>
                    <p className="text-blue-700 dark:text-blue-300 mt-1">
                      Multiple variants and automated winner selection are not supported by the current sequence storage. Save one variant per step.
                    </p>
                  </div>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
