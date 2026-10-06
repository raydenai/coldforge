'use client'

import { useEffect, useState, useCallback } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'
import {
  User,
  Building2,
  Bell,
  Loader2,
  Upload,
  Plus,
  Trash2
} from 'lucide-react'

// Types
interface ProfileData {
  id: string
  email: string
  full_name: string | null
  avatar_url: string | null
  timezone: string
  role: 'owner' | 'admin' | 'member'
}

interface OrganizationData {
  id: string
  name: string
  slug: string
  plan: 'starter' | 'pro' | 'agency'
  domain: string | null
  settings: {
    default_timezone?: string
    default_daily_limit?: number
  }
}

interface TeamMember {
  id: string
  email: string
  full_name: string | null
  role: 'owner' | 'admin' | 'member'
  avatar_url: string | null
  created_at: string
}

interface NotificationSettings {
  campaign_alerts: boolean
  reply_notifications: boolean
  weekly_digest: boolean
  daily_summary: boolean
  bounce_alerts: boolean
  warmup_updates: boolean
}


// Timezone list
const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Singapore',
  'Australia/Sydney',
  'Pacific/Auckland',
]

export default function SettingsContent() {
  const [activeTab, setActiveTab] = useState('profile')

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">
          Manage your account and organization settings
        </p>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList className="grid w-full grid-cols-3 lg:w-auto lg:grid-cols-none lg:flex">
          <TabsTrigger value="profile" className="gap-2">
            <User className="h-4 w-4" />
            <span className="hidden sm:inline">Profile</span>
          </TabsTrigger>
          <TabsTrigger value="organization" className="gap-2">
            <Building2 className="h-4 w-4" />
            <span className="hidden sm:inline">Organization</span>
          </TabsTrigger>
          <TabsTrigger value="notifications" className="gap-2">
            <Bell className="h-4 w-4" />
            <span className="hidden sm:inline">Notifications</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="profile">
          <ProfileTab />
        </TabsContent>

        <TabsContent value="organization">
          <OrganizationTab />
        </TabsContent>

        <TabsContent value="notifications">
          <NotificationsTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// Profile Tab Component
function ProfileTab() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [profile, setProfile] = useState<ProfileData | null>(null)
  const [formData, setFormData] = useState({
    full_name: '',
    timezone: 'America/New_York',
  })

  const fetchProfile = useCallback(async () => {
    try {
      const response = await fetch('/api/settings/profile')
      const data = await response.json()
      if (data.profile) {
        setProfile(data.profile)
        setFormData({
          full_name: data.profile.full_name || '',
          timezone: data.profile.timezone || 'America/New_York',
        })
      }
    } catch {
      toast.error('Failed to load profile')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchProfile()
  }, [fetchProfile])

  const handleSave = async () => {
    setSaving(true)
    try {
      const response = await fetch('/api/settings/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      })

      if (!response.ok) {
        throw new Error('Failed to save')
      }

      toast.success('Profile updated successfully')
      fetchProfile()
    } catch {
      toast.error('Failed to save profile')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <ProfileSkeleton />
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Profile Settings</CardTitle>
          <CardDescription>
            Update your personal information and preferences
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center gap-6">
            <Avatar className="h-20 w-20">
              <AvatarImage src={profile?.avatar_url || undefined} />
              <AvatarFallback className="text-2xl">
                {profile?.full_name?.charAt(0) || profile?.email?.charAt(0) || 'U'}
              </AvatarFallback>
            </Avatar>
            <div className="space-y-2">
              <Button variant="outline" size="sm" disabled>
                <Upload className="mr-2 h-4 w-4" />
                Upload Photo
              </Button>
              <p className="text-xs text-muted-foreground">
                JPG, PNG or GIF. Max 2MB.
              </p>
            </div>
          </div>

          <Separator />

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="full_name">Full Name</Label>
              <Input
                id="full_name"
                value={formData.full_name}
                onChange={(e) => setFormData(prev => ({ ...prev, full_name: e.target.value }))}
                placeholder="John Doe"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={profile?.email || ''}
                disabled
              />
              <p className="text-xs text-muted-foreground">
                Email cannot be changed
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="timezone">Timezone</Label>
            <Select
              value={formData.timezone}
              onValueChange={(value) => setFormData(prev => ({ ...prev, timezone: value }))}
            >
              <SelectTrigger id="timezone">
                <SelectValue placeholder="Select timezone" />
              </SelectTrigger>
              <SelectContent>
                {TIMEZONES.map((tz) => (
                  <SelectItem key={tz} value={tz}>
                    {tz.replace(/_/g, ' ')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between rounded-lg border p-4">
            <div>
              <p className="font-medium">Role</p>
              <p className="text-sm text-muted-foreground">
                Your role in the organization
              </p>
            </div>
            <Badge variant={profile?.role === 'owner' ? 'default' : 'secondary'}>
              {profile?.role}
            </Badge>
          </div>

          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Changes
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function ProfileSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-4 w-64" />
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center gap-6">
          <Skeleton className="h-20 w-20 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-9 w-32" />
            <Skeleton className="h-3 w-40" />
          </div>
        </div>
        <Separator />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-10 w-full" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-10 w-full" />
          </div>
        </div>
        <div className="space-y-2">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-10 w-full" />
        </div>
      </CardContent>
    </Card>
  )
}

// Organization Tab Component
function OrganizationTab() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [organization, setOrganization] = useState<OrganizationData | null>(null)
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([])
  const [formData, setFormData] = useState({
    name: '',
    domain: '',
    default_timezone: 'America/New_York',
    default_daily_limit: 50,
  })

  const fetchOrganization = useCallback(async () => {
    try {
      const response = await fetch('/api/settings/organization')
      const data = await response.json()
      if (data.organization) {
        setOrganization(data.organization)
        setTeamMembers(data.team_members || [])
        setFormData({
          name: data.organization.name || '',
          domain: data.organization.domain || '',
          default_timezone: data.organization.settings?.default_timezone || 'America/New_York',
          default_daily_limit: data.organization.settings?.default_daily_limit || 50,
        })
      }
    } catch {
      toast.error('Failed to load organization')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchOrganization()
  }, [fetchOrganization])

  const handleSave = async () => {
    setSaving(true)
    try {
      const response = await fetch('/api/settings/organization', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      })

      if (!response.ok) {
        throw new Error('Failed to save')
      }

      toast.success('Organization updated successfully')
      fetchOrganization()
    } catch {
      toast.error('Failed to save organization')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <OrganizationSkeleton />
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Organization Settings</CardTitle>
          <CardDescription>
            Manage your organization details and defaults
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="org_name">Organization Name</Label>
              <Input
                id="org_name"
                value={formData.name}
                onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                placeholder="My Company"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="org_slug">Slug</Label>
              <Input
                id="org_slug"
                value={organization?.slug || ''}
                disabled
              />
              <p className="text-xs text-muted-foreground">
                Organization identifier (cannot be changed)
              </p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="org_domain">Company Domain</Label>
              <Input
                id="org_domain"
                value={formData.domain}
                onChange={(e) => setFormData(prev => ({ ...prev, domain: e.target.value }))}
                placeholder="example.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="default_timezone">Default Timezone</Label>
              <Select
                value={formData.default_timezone}
                onValueChange={(value) => setFormData(prev => ({ ...prev, default_timezone: value }))}
              >
                <SelectTrigger id="default_timezone">
                  <SelectValue placeholder="Select timezone" />
                </SelectTrigger>
                <SelectContent>
                  {TIMEZONES.map((tz) => (
                    <SelectItem key={tz} value={tz}>
                      {tz.replace(/_/g, ' ')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="default_daily_limit">Default Daily Email Limit</Label>
            <Input
              id="default_daily_limit"
              type="number"
              min={1}
              max={500}
              value={formData.default_daily_limit}
              onChange={(e) => setFormData(prev => ({ ...prev, default_daily_limit: parseInt(e.target.value) || 50 }))}
            />
            <p className="text-xs text-muted-foreground">
              Default sending limit for new email accounts (1-500)
            </p>
          </div>

          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Changes
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Team Members</CardTitle>
              <CardDescription>
                Manage your team and their roles
              </CardDescription>
            </div>
            <Button disabled>
              <Plus className="mr-2 h-4 w-4" />
              Invite Member
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {teamMembers.length === 0 ? (
              <p className="text-center text-sm text-muted-foreground py-8">
                No team members yet. Invite someone to get started.
              </p>
            ) : (
              teamMembers.map((member) => (
                <div key={member.id} className="flex items-center justify-between rounded-lg border p-4">
                  <div className="flex items-center gap-4">
                    <Avatar>
                      <AvatarImage src={member.avatar_url || undefined} />
                      <AvatarFallback>
                        {member.full_name?.charAt(0) || member.email.charAt(0)}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="font-medium">{member.full_name || member.email}</p>
                      <p className="text-sm text-muted-foreground">{member.email}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <Badge variant={member.role === 'owner' ? 'default' : 'secondary'}>
                      {member.role}
                    </Badge>
                    {member.role !== 'owner' && (
                      <Button variant="ghost" size="icon" disabled>
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function OrganizationSkeleton() {
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-4 w-64" />
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-10 w-full" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-10 w-full" />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-10 w-full" />
            </div>
            <div className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-10 w-full" />
            </div>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-48" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    </div>
  )
}

// Notifications Tab Component
function NotificationsTab() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [settings, setSettings] = useState<NotificationSettings>({
    campaign_alerts: true,
    reply_notifications: true,
    weekly_digest: true,
    daily_summary: false,
    bounce_alerts: true,
    warmup_updates: false,
  })

  const fetchSettings = useCallback(async () => {
    try {
      const response = await fetch('/api/settings/notifications')
      const data = await response.json()
      if (data.settings) {
        setSettings(data.settings)
      }
    } catch {
      toast.error('Failed to load notification settings')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchSettings()
  }, [fetchSettings])

  const handleToggle = async (key: keyof NotificationSettings) => {
    const newSettings = { ...settings, [key]: !settings[key] }
    setSettings(newSettings)
    setSaving(true)

    try {
      const response = await fetch('/api/settings/notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSettings),
      })

      if (!response.ok) {
        throw new Error('Failed to save')
      }

      toast.success('Notification settings updated')
    } catch {
      setSettings(settings) // Revert on error
      toast.error('Failed to update settings')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return <NotificationsSkeleton />
  }

  const notificationOptions = [
    {
      key: 'campaign_alerts' as const,
      title: 'Campaign Alerts',
      description: 'Get notified when campaigns start, pause, or complete',
    },
    {
      key: 'reply_notifications' as const,
      title: 'Reply Notifications',
      description: 'Instant notifications when leads reply to your emails',
    },
    {
      key: 'bounce_alerts' as const,
      title: 'Bounce Alerts',
      description: 'Get alerted when emails bounce or fail to deliver',
    },
    {
      key: 'warmup_updates' as const,
      title: 'Warmup Updates',
      description: 'Daily updates on your email warmup progress',
    },
    {
      key: 'daily_summary' as const,
      title: 'Daily Summary',
      description: 'Receive a daily summary of your campaign performance',
    },
    {
      key: 'weekly_digest' as const,
      title: 'Weekly Digest',
      description: 'Weekly overview of all your email campaigns',
    },
  ]

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notification Preferences</CardTitle>
        <CardDescription>
          Choose which notifications you want to receive
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {notificationOptions.map((option) => (
          <div key={option.key} className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <p className="font-medium">{option.title}</p>
              <p className="text-sm text-muted-foreground">{option.description}</p>
            </div>
            <Switch
              checked={settings[option.key]}
              onCheckedChange={() => handleToggle(option.key)}
              disabled={saving}
            />
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function NotificationsSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-64" />
      </CardHeader>
      <CardContent className="space-y-6">
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-64" />
            </div>
            <Skeleton className="h-5 w-9" />
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
