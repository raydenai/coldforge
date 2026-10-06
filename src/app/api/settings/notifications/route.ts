import { assertSameOrigin, winnrErrorResponse } from '@/app/api/winnr/_shared'
import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import type { Json } from '@/types/database'

interface NotificationSettings {
  campaign_alerts: boolean
  reply_notifications: boolean
  weekly_digest: boolean
  daily_summary: boolean
  bounce_alerts: boolean
  warmup_updates: boolean
}

interface UserSettings {
  settings: Json
}

const DEFAULT_SETTINGS: NotificationSettings = {
  campaign_alerts: true,
  reply_notifications: true,
  weekly_digest: true,
  daily_summary: false,
  bounce_alerts: true,
  warmup_updates: false,
}

// GET /api/settings/notifications - Get notification settings
export async function GET() {
  try {
    const supabase = await createClient()

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Get user settings
    const { data: profile, error } = await supabase
      .from('users')
      .select('settings')
      .eq('id', user.id)
      .single() as { data: UserSettings | null; error: { code?: string; message?: string } | null }

    if (error && error.code !== 'PGRST116') {
      throw error
    }

    const userSettings = (profile?.settings as Record<string, unknown>) || {}
    const notificationSettings = (userSettings.notifications as NotificationSettings) || DEFAULT_SETTINGS

    return NextResponse.json({
      settings: {
        ...DEFAULT_SETTINGS,
        ...notificationSettings
      }
    })
  } catch (error) {
    console.error('Failed to fetch notification settings:', error)
    return NextResponse.json(
      { error: 'Failed to fetch notification settings' },
      { status: 500 }
    )
  }
}

// PATCH /api/settings/notifications - Update notification settings
export async function PATCH(request: NextRequest) {
  try { assertSameOrigin(request) } catch (error) { return winnrErrorResponse(error) }
  try {
    const supabase = await createClient()

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const body = await request.json()

    // Validate the settings
    const validKeys = Object.keys(DEFAULT_SETTINGS) as (keyof NotificationSettings)[]
    const newNotificationSettings: Partial<NotificationSettings> = {}

    for (const key of validKeys) {
      if (key in body && typeof body[key] === 'boolean') {
        newNotificationSettings[key] = body[key]
      }
    }

    // Get current settings
    const { data: currentProfile } = await supabase
      .from('users')
      .select('settings')
      .eq('id', user.id)
      .single() as { data: UserSettings | null }

    const currentSettings = (currentProfile?.settings as Record<string, unknown>) || {}
    const currentNotifications = (currentSettings.notifications as NotificationSettings) || DEFAULT_SETTINGS

    // Merge settings
    const updatedNotifications: NotificationSettings = {
      ...currentNotifications,
      ...newNotificationSettings
    }

    const updatedSettings = {
      ...currentSettings,
      notifications: updatedNotifications
    } as unknown as Json

    const { error } = await supabase
      .from('users')

      .update({
        settings: updatedSettings,
        updated_at: new Date().toISOString()
      })
      .eq('id', user.id)

    if (error) {
      throw error
    }

    return NextResponse.json({
      settings: updatedNotifications
    })
  } catch (error) {
    console.error('Failed to update notification settings:', error)
    return NextResponse.json(
      { error: 'Failed to update notification settings' },
      { status: 500 }
    )
  }
}
