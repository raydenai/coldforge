// Analytics Event Tracking System
import { createClient } from '@/lib/supabase/server';
import type {
  AnalyticsEvent,
  AnalyticsEventType,
  DateRange,
  TimeRange,
} from './types';

// Track an analytics event
export async function trackEvent(
  event: Omit<AnalyticsEvent, 'id' | 'timestamp'>
): Promise<string> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('analytics_events')
    .insert({
      workspace_id: event.workspaceId,
      event_type: event.eventType,
      user_id: event.userId,
      campaign_id: event.campaignId,
      lead_id: event.leadId,
      mailbox_id: event.mailboxId,
      sequence_id: event.sequenceId,
      email_id: event.emailId,
      metadata: event.metadata || {},
      ip_address: event.ipAddress,
      user_agent: event.userAgent,
      device_type: event.deviceType,
      browser: event.browser,
      os: event.os,
      country: event.country,
      city: event.city,
    })
    .select('id')
    .single();

  if (error) {
    console.error('Error tracking event:', error);
    throw error;
  }

  return data.id;
}

// Batch track multiple events
export async function trackEvents(
  events: Omit<AnalyticsEvent, 'id' | 'timestamp'>[]
): Promise<number> {
  if (events.length === 0) return 0;

  const supabase = await createClient();

  const { data, error } = await supabase
    .from('analytics_events')
    .insert(
      events.map((event) => ({
        workspace_id: event.workspaceId,
        event_type: event.eventType,
        user_id: event.userId,
        campaign_id: event.campaignId,
        lead_id: event.leadId,
        mailbox_id: event.mailboxId,
        sequence_id: event.sequenceId,
        email_id: event.emailId,
        metadata: event.metadata || {},
        ip_address: event.ipAddress,
        user_agent: event.userAgent,
        device_type: event.deviceType,
        browser: event.browser,
        os: event.os,
        country: event.country,
        city: event.city,
      }))
    )
    .select('id');

  if (error) {
    console.error('Error batch tracking events:', error);
    throw error;
  }

  return data?.length || 0;
}

// Get events with filtering
export async function getEvents(
  workspaceId: string,
  options: {
    eventTypes?: AnalyticsEventType[];
    campaignId?: string;
    leadId?: string;
    mailboxId?: string;
    dateRange?: DateRange;
    timeRange?: TimeRange;
    limit?: number;
    offset?: number;
  } = {}
): Promise<{ events: AnalyticsEvent[]; total: number }> {
  const supabase = await createClient();

  const { dateRange, timeRange } = resolveDateRange(
    options.dateRange,
    options.timeRange
  );

  let query = supabase
    .from('analytics_events')
    .select('*', { count: 'exact' })
    .eq('workspace_id', workspaceId)
    .gte('created_at', dateRange.startDate.toISOString())
    .lte('created_at', dateRange.endDate.toISOString())
    .order('created_at', { ascending: false });

  if (options.eventTypes && options.eventTypes.length > 0) {
    query = query.in('event_type', options.eventTypes);
  }

  if (options.campaignId) {
    query = query.eq('campaign_id', options.campaignId);
  }

  if (options.leadId) {
    query = query.eq('lead_id', options.leadId);
  }

  if (options.mailboxId) {
    query = query.eq('mailbox_id', options.mailboxId);
  }

  const limit = options.limit || 100;
  const offset = options.offset || 0;
  query = query.range(offset, offset + limit - 1);

  const { data, count, error } = await query;

  if (error) {
    throw error;
  }

  return {
    events: (data || []).map(mapEvent),
    total: count || 0,
  };
}

// Count events by type
export async function countEventsByType(
  workspaceId: string,
  options: {
    dateRange?: DateRange;
    timeRange?: TimeRange;
    campaignId?: string;
  } = {}
): Promise<Record<AnalyticsEventType, number>> {
  const supabase = await createClient();

  const { dateRange } = resolveDateRange(options.dateRange, options.timeRange);

  const query = supabase.rpc('count_events_by_type', {
    p_workspace_id: workspaceId,
    p_start_date: dateRange.startDate.toISOString(),
    p_end_date: dateRange.endDate.toISOString(),
    p_campaign_id: options.campaignId || null,
  });

  const { data, error } = await query;

  if (error) {
    // Fallback to manual counting if function doesn't exist
    console.warn('Using fallback event counting:', error);
    return await countEventsByTypeFallback(workspaceId, options);
  }

  const counts: Record<string, number> = {};
  for (const row of data || []) {
    counts[row.event_type] = parseInt(row.count, 10);
  }

  return counts as Record<AnalyticsEventType, number>;
}

// Fallback counting method
async function countEventsByTypeFallback(
  workspaceId: string,
  options: {
    dateRange?: DateRange;
    timeRange?: TimeRange;
    campaignId?: string;
  }
): Promise<Record<AnalyticsEventType, number>> {
  const supabase = await createClient();

  const { dateRange } = resolveDateRange(options.dateRange, options.timeRange);

  let query = supabase
    .from('analytics_events')
    .select('event_type')
    .eq('workspace_id', workspaceId)
    .gte('created_at', dateRange.startDate.toISOString())
    .lte('created_at', dateRange.endDate.toISOString());

  if (options.campaignId) {
    query = query.eq('campaign_id', options.campaignId);
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  const counts: Record<string, number> = {};
  for (const row of data || []) {
    const eventType = row.event_type as AnalyticsEventType;
    counts[eventType] = (counts[eventType] || 0) + 1;
  }

  return counts as Record<AnalyticsEventType, number>;
}

// Get event time series
export async function getEventTimeSeries(
  workspaceId: string,
  eventType: AnalyticsEventType,
  options: {
    dateRange?: DateRange;
    timeRange?: TimeRange;
    granularity?: 'hour' | 'day' | 'week' | 'month';
    campaignId?: string;
  } = {}
): Promise<Array<{ timestamp: Date; count: number }>> {
  const supabase = await createClient();

  const { dateRange } = resolveDateRange(options.dateRange, options.timeRange);
  const granularity = options.granularity || 'day';

  // Format for date truncation
  const truncFormat = {
    hour: 'YYYY-MM-DD HH24:00:00',
    day: 'YYYY-MM-DD',
    week: 'IYYY-IW',
    month: 'YYYY-MM',
  }[granularity];

  let query = supabase
    .from('analytics_events')
    .select('created_at')
    .eq('workspace_id', workspaceId)
    .eq('event_type', eventType)
    .gte('created_at', dateRange.startDate.toISOString())
    .lte('created_at', dateRange.endDate.toISOString());

  if (options.campaignId) {
    query = query.eq('campaign_id', options.campaignId);
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  // Group by time bucket
  const buckets = new Map<string, number>();

  for (const row of data || []) {
    const date = new Date(row.created_at);
    const key = formatDateBucket(date, granularity);
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }

  // Convert to array and sort
  const result = Array.from(buckets.entries())
    .map(([key, count]) => ({
      timestamp: parseDateBucket(key, granularity),
      count,
    }))
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  return result;
}

// Track email open (with unique detection)
export async function trackEmailOpen(
  workspaceId: string,
  emailId: string,
  trackingData: {
    leadId: string;
    campaignId: string;
    ipAddress?: string;
    userAgent?: string;
  }
): Promise<{ isFirstOpen: boolean }> {
  const supabase = await createClient();

  // Check if already opened
  const { data: existing } = await supabase
    .from('analytics_events')
    .select('id')
    .eq('email_id', emailId)
    .eq('event_type', 'email_opened')
    .limit(1)
    .single();

  const isFirstOpen = !existing;

  // Parse user agent
  const deviceInfo = parseUserAgent(trackingData.userAgent);

  // Track the event
  await trackEvent({
    workspaceId,
    eventType: 'email_opened',
    emailId,
    leadId: trackingData.leadId,
    campaignId: trackingData.campaignId,
    ipAddress: trackingData.ipAddress,
    userAgent: trackingData.userAgent,
    deviceType: deviceInfo.deviceType,
    browser: deviceInfo.browser,
    os: deviceInfo.os,
    metadata: {
      isFirstOpen,
    },
  });

  // Update email stats if first open
  if (isFirstOpen) {
    await supabase
      .from('sent_emails')
      .update({
        opened_at: new Date().toISOString(),
        open_count: 1,
      })
      .eq('id', emailId);
  } else {
    // Increment open count
    await supabase.rpc('increment_email_open_count', {
      p_email_id: emailId,
    });
  }

  return { isFirstOpen };
}

// Track email click
export async function trackEmailClick(
  workspaceId: string,
  emailId: string,
  trackingData: {
    leadId: string;
    campaignId: string;
    linkUrl: string;
    linkIndex?: number;
    ipAddress?: string;
    userAgent?: string;
  }
): Promise<{ isFirstClick: boolean }> {
  const supabase = await createClient();

  // Check if already clicked
  const { data: existing } = await supabase
    .from('analytics_events')
    .select('id')
    .eq('email_id', emailId)
    .eq('event_type', 'email_clicked')
    .limit(1)
    .single();

  const isFirstClick = !existing;

  // Parse user agent
  const deviceInfo = parseUserAgent(trackingData.userAgent);

  // Track the event
  await trackEvent({
    workspaceId,
    eventType: 'email_clicked',
    emailId,
    leadId: trackingData.leadId,
    campaignId: trackingData.campaignId,
    ipAddress: trackingData.ipAddress,
    userAgent: trackingData.userAgent,
    deviceType: deviceInfo.deviceType,
    browser: deviceInfo.browser,
    os: deviceInfo.os,
    metadata: {
      isFirstClick,
      linkUrl: trackingData.linkUrl,
      linkIndex: trackingData.linkIndex,
    },
  });

  // Update email stats if first click
  if (isFirstClick) {
    await supabase
      .from('sent_emails')
      .update({
        clicked_at: new Date().toISOString(),
        click_count: 1,
      })
      .eq('id', emailId);
  } else {
    // Increment click count
    await supabase.rpc('increment_email_click_count', {
      p_email_id: emailId,
    });
  }

  return { isFirstClick };
}

// Helper: Resolve date range from TimeRange
export function resolveDateRange(
  dateRange?: DateRange,
  timeRange?: TimeRange
): { dateRange: DateRange; period: string } {
  if (dateRange) {
    return { dateRange, period: 'custom' };
  }

  const now = new Date();
  const endDate = new Date(now);
  let startDate: Date;
  const period: string = timeRange || '30d';

  switch (timeRange) {
    case 'today':
      startDate = new Date(now.setHours(0, 0, 0, 0));
      break;
    case 'yesterday':
      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 1);
      startDate.setHours(0, 0, 0, 0);
      endDate.setDate(endDate.getDate() - 1);
      endDate.setHours(23, 59, 59, 999);
      break;
    case '7d':
      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 7);
      break;
    case '14d':
      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 14);
      break;
    case '30d':
    default:
      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 30);
      break;
    case '90d':
      startDate = new Date(now);
      startDate.setDate(startDate.getDate() - 90);
      break;
    case '12m':
      startDate = new Date(now);
      startDate.setMonth(startDate.getMonth() - 12);
      break;
    case 'all':
      startDate = new Date(0); // Beginning of time
      break;
  }

  return {
    dateRange: { startDate, endDate },
    period,
  };
}

// Helper: Format date for bucket
function formatDateBucket(
  date: Date,
  granularity: 'hour' | 'day' | 'week' | 'month'
): string {
  switch (granularity) {
    case 'hour':
      return date.toISOString().slice(0, 13);
    case 'day':
      return date.toISOString().slice(0, 10);
    case 'week':
      const weekStart = new Date(date);
      weekStart.setDate(date.getDate() - date.getDay());
      return weekStart.toISOString().slice(0, 10);
    case 'month':
      return date.toISOString().slice(0, 7);
  }
}

// Helper: Parse date bucket back to Date
function parseDateBucket(
  bucket: string,
  granularity: 'hour' | 'day' | 'week' | 'month'
): Date {
  switch (granularity) {
    case 'hour':
      return new Date(bucket + ':00:00.000Z');
    case 'day':
    case 'week':
      return new Date(bucket + 'T00:00:00.000Z');
    case 'month':
      return new Date(bucket + '-01T00:00:00.000Z');
  }
}

// Helper: Parse user agent
function parseUserAgent(userAgent?: string): {
  deviceType?: 'desktop' | 'mobile' | 'tablet';
  browser?: string;
  os?: string;
} {
  if (!userAgent) return {};

  const ua = userAgent.toLowerCase();

  // Device type
  let deviceType: 'desktop' | 'mobile' | 'tablet' = 'desktop';
  if (/mobile|android|iphone/i.test(ua)) {
    deviceType = 'mobile';
  } else if (/ipad|tablet/i.test(ua)) {
    deviceType = 'tablet';
  }

  // Browser
  let browser = 'Unknown';
  if (/chrome/i.test(ua) && !/chromium|edg/i.test(ua)) {
    browser = 'Chrome';
  } else if (/firefox/i.test(ua)) {
    browser = 'Firefox';
  } else if (/safari/i.test(ua) && !/chrome/i.test(ua)) {
    browser = 'Safari';
  } else if (/edg/i.test(ua)) {
    browser = 'Edge';
  } else if (/opera|opr/i.test(ua)) {
    browser = 'Opera';
  }

  // OS
  let os = 'Unknown';
  if (/windows/i.test(ua)) {
    os = 'Windows';
  } else if (/macintosh|mac os/i.test(ua)) {
    os = 'macOS';
  } else if (/linux/i.test(ua) && !/android/i.test(ua)) {
    os = 'Linux';
  } else if (/android/i.test(ua)) {
    os = 'Android';
  } else if (/iphone|ipad|ipod/i.test(ua)) {
    os = 'iOS';
  }

  return { deviceType, browser, os };
}

// Helper: Map database row to AnalyticsEvent
function mapEvent(row: Record<string, unknown>): AnalyticsEvent {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    eventType: row.event_type as AnalyticsEventType,
    timestamp: new Date(row.created_at as string),
    userId: row.user_id as string | undefined,
    campaignId: row.campaign_id as string | undefined,
    leadId: row.lead_id as string | undefined,
    mailboxId: row.mailbox_id as string | undefined,
    sequenceId: row.sequence_id as string | undefined,
    emailId: row.email_id as string | undefined,
    metadata: row.metadata as Record<string, unknown> | undefined,
    ipAddress: row.ip_address as string | undefined,
    userAgent: row.user_agent as string | undefined,
    deviceType: row.device_type as 'desktop' | 'mobile' | 'tablet' | undefined,
    browser: row.browser as string | undefined,
    os: row.os as string | undefined,
    country: row.country as string | undefined,
    city: row.city as string | undefined,
  };
}
