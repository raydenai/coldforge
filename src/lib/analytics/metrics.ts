// Analytics Metrics Calculation
import { createClient } from '@/lib/supabase/server';
import type {
  EmailMetrics,
  CampaignMetrics,
  WorkspaceMetrics,
  TimeSeriesData,
  MetricBreakdown,
  DateRange,
  TimeRange,
  AggregationPeriod,
  PeriodComparison,
  MetricComparison,
  FunnelData,
} from './types';
import { resolveDateRange, countEventsByType } from './events';

// Get email metrics for a date range
export async function getEmailMetrics(
  workspaceId: string,
  options: {
    dateRange?: DateRange;
    timeRange?: TimeRange;
    campaignId?: string;
  } = {}
): Promise<EmailMetrics> {
  const counts = await countEventsByType(workspaceId, options);

  const sent = counts.email_sent || 0;
  const delivered = counts.email_delivered || 0;
  const opened = counts.email_opened || 0;
  const clicked = counts.email_clicked || 0;
  const replied = counts.email_replied || 0;
  const bounced = counts.email_bounced || 0;
  const unsubscribed = counts.email_unsubscribed || 0;
  const markedSpam = counts.email_marked_spam || 0;

  return {
    sent,
    delivered,
    opened,
    clicked,
    replied,
    bounced,
    unsubscribed,
    markedSpam,
    deliveryRate: sent > 0 ? (delivered / sent) * 100 : 0,
    openRate: delivered > 0 ? (opened / delivered) * 100 : 0,
    clickRate: delivered > 0 ? (clicked / delivered) * 100 : 0,
    replyRate: delivered > 0 ? (replied / delivered) * 100 : 0,
    bounceRate: sent > 0 ? (bounced / sent) * 100 : 0,
    unsubscribeRate: delivered > 0 ? (unsubscribed / delivered) * 100 : 0,
    spamRate: delivered > 0 ? (markedSpam / delivered) * 100 : 0,
  };
}

// Get campaign metrics
export async function getCampaignMetrics(
  campaignId: string
): Promise<CampaignMetrics | null> {
  const supabase = await createClient();

  // Get campaign details
  const { data: campaign, error } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', campaignId)
    .single();

  if (error || !campaign) {
    return null;
  }

  // Get email metrics for this campaign
  const emailMetrics = await getEmailMetrics(campaign.workspace_id, {
    campaignId,
  });

  // Get lead counts
  const { count: totalLeads } = await supabase
    .from('campaign_leads')
    .select('*', { count: 'exact', head: true })
    .eq('campaign_id', campaignId);

  const { count: contactedLeads } = await supabase
    .from('campaign_leads')
    .select('*', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .not('last_contacted_at', 'is', null);

  const { count: respondedLeads } = await supabase
    .from('campaign_leads')
    .select('*', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .eq('status', 'replied');

  const { count: activeLeads } = await supabase
    .from('campaign_leads')
    .select('*', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
    .in('status', ['active', 'pending']);

  // Calculate total sequence steps completed across all leads
  // Each lead's current_step indicates how many steps they've completed
  const { data: stepsData } = await supabase
    .from('campaign_leads')
    .select('current_step')
    .eq('campaign_id', campaignId);

  const sequenceStepsCompleted = stepsData?.reduce((sum, lead) => {
    return sum + (lead.current_step || 0);
  }, 0) || 0;

  return {
    ...emailMetrics,
    campaignId,
    campaignName: campaign.name,
    status: campaign.status,
    startedAt: campaign.started_at ? new Date(campaign.started_at) : undefined,
    completedAt: campaign.completed_at
      ? new Date(campaign.completed_at)
      : undefined,
    totalLeads: totalLeads || 0,
    activeLeads: activeLeads || 0,
    contactedLeads: contactedLeads || 0,
    respondedLeads: respondedLeads || 0,
    sequenceStepsCompleted,
  };
}

// Get workspace overview metrics
export async function getWorkspaceMetrics(
  workspaceId: string,
  options: {
    dateRange?: DateRange;
    timeRange?: TimeRange;
  } = {}
): Promise<WorkspaceMetrics> {
  const supabase = await createClient();

  // Get email metrics
  const emailMetrics = await getEmailMetrics(workspaceId, options);

  // Get campaign counts
  const { count: totalCampaigns } = await supabase
    .from('campaigns')
    .select('*', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId);

  const { count: activeCampaigns } = await supabase
    .from('campaigns')
    .select('*', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .eq('status', 'active');

  // Get lead counts
  const { count: totalLeads } = await supabase
    .from('leads')
    .select('*', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId);

  const { count: activeLeads } = await supabase
    .from('leads')
    .select('*', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .not('status', 'in', '("unsubscribed","bounced","deleted")');

  // Get mailbox counts
  const { count: totalMailboxes } = await supabase
    .from('mailboxes')
    .select('*', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId);

  const { count: activeMailboxes } = await supabase
    .from('mailboxes')
    .select('*', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .eq('status', 'active');

  // Get average health scores
  const { data: healthData } = await supabase
    .from('mailboxes')
    .select('health_score')
    .eq('workspace_id', workspaceId)
    .eq('status', 'active');

  const avgMailboxHealth =
    healthData && healthData.length > 0
      ? healthData.reduce((sum, m) => sum + (m.health_score || 0), 0) /
        healthData.length
      : 0;

  const { data: domainData } = await supabase
    .from('domains')
    .select('reputation_score')
    .eq('workspace_id', workspaceId)
    .eq('status', 'active');

  const avgDomainHealth =
    domainData && domainData.length > 0
      ? domainData.reduce((sum, d) => sum + (d.reputation_score || 0), 0) /
        domainData.length
      : 0;

  return {
    totalEmailsSent: emailMetrics.sent,
    totalEmailsDelivered: emailMetrics.delivered,
    totalOpens: emailMetrics.opened,
    totalClicks: emailMetrics.clicked,
    totalReplies: emailMetrics.replied,
    totalBounces: emailMetrics.bounced,
    avgOpenRate: emailMetrics.openRate,
    avgClickRate: emailMetrics.clickRate,
    avgReplyRate: emailMetrics.replyRate,
    avgBounceRate: emailMetrics.bounceRate,
    totalCampaigns: totalCampaigns || 0,
    activeCampaigns: activeCampaigns || 0,
    totalLeads: totalLeads || 0,
    activeLeads: activeLeads || 0,
    totalMailboxes: totalMailboxes || 0,
    activeMailboxes: activeMailboxes || 0,
    avgMailboxHealth,
    avgDomainHealth,
  };
}

// Get metrics time series
export async function getMetricsTimeSeries(
  workspaceId: string,
  metric: string,
  options: {
    dateRange?: DateRange;
    timeRange?: TimeRange;
    period?: AggregationPeriod;
    campaignId?: string;
  } = {}
): Promise<TimeSeriesData> {
  const supabase = await createClient();
  const { dateRange } = resolveDateRange(options.dateRange, options.timeRange);
  const period = options.period || 'day';

  // Map metric to event type
  const eventTypeMap: Record<string, string> = {
    sent: 'email_sent',
    delivered: 'email_delivered',
    opens: 'email_opened',
    clicks: 'email_clicked',
    replies: 'email_replied',
    bounces: 'email_bounced',
    unsubscribes: 'email_unsubscribed',
  };

  const eventType = eventTypeMap[metric];
  if (!eventType) {
    throw new Error(`Unknown metric: ${metric}`);
  }

  // Query events grouped by time period
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

  // Group by period
  const buckets = new Map<string, number>();

  for (const row of data || []) {
    const date = new Date(row.created_at);
    const key = formatPeriodKey(date, period);
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }

  // Convert to data points
  const dataPoints = Array.from(buckets.entries())
    .map(([key, value]) => ({
      timestamp: parsePeriodKey(key, period),
      value,
    }))
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  const values = dataPoints.map((d) => d.value);
  const total = values.reduce((sum, v) => sum + v, 0);
  const average = values.length > 0 ? total / values.length : 0;
  const min = values.length > 0 ? Math.min(...values) : 0;
  const max = values.length > 0 ? Math.max(...values) : 0;

  // Calculate trend (compare last half to first half)
  let trend: 'up' | 'down' | 'stable' = 'stable';
  let trendPercentage = 0;

  if (dataPoints.length >= 2) {
    const midpoint = Math.floor(dataPoints.length / 2);
    const firstHalf = dataPoints.slice(0, midpoint);
    const secondHalf = dataPoints.slice(midpoint);

    const firstHalfAvg =
      firstHalf.reduce((sum, d) => sum + d.value, 0) / firstHalf.length;
    const secondHalfAvg =
      secondHalf.reduce((sum, d) => sum + d.value, 0) / secondHalf.length;

    if (firstHalfAvg > 0) {
      trendPercentage = ((secondHalfAvg - firstHalfAvg) / firstHalfAvg) * 100;
      trend = trendPercentage > 5 ? 'up' : trendPercentage < -5 ? 'down' : 'stable';
    }
  }

  return {
    metric,
    period,
    data: dataPoints,
    total,
    average,
    min,
    max,
    trend,
    trendPercentage,
  };
}

// Get period comparison
export async function getPeriodComparison(
  workspaceId: string,
  options: {
    currentPeriod: DateRange;
    previousPeriod: DateRange;
    campaignId?: string;
  }
): Promise<PeriodComparison> {
  const currentMetrics = await getEmailMetrics(workspaceId, {
    dateRange: options.currentPeriod,
    campaignId: options.campaignId,
  });

  const previousMetrics = await getEmailMetrics(workspaceId, {
    dateRange: options.previousPeriod,
    campaignId: options.campaignId,
  });

  const createComparison = (
    metric: string,
    current: number,
    previous: number,
    higherIsBetter: boolean = true
  ): MetricComparison => {
    const change = current - previous;
    const changePercentage = previous > 0 ? (change / previous) * 100 : 0;
    const trend: 'up' | 'down' | 'stable' =
      changePercentage > 5 ? 'up' : changePercentage < -5 ? 'down' : 'stable';

    return {
      metric,
      current,
      previous,
      change,
      changePercentage,
      trend,
      isPositive: higherIsBetter ? change >= 0 : change <= 0,
    };
  };

  return {
    currentPeriod: options.currentPeriod,
    previousPeriod: options.previousPeriod,
    metrics: [
      createComparison('sent', currentMetrics.sent, previousMetrics.sent),
      createComparison('delivered', currentMetrics.delivered, previousMetrics.delivered),
      createComparison('opened', currentMetrics.opened, previousMetrics.opened),
      createComparison('clicked', currentMetrics.clicked, previousMetrics.clicked),
      createComparison('replied', currentMetrics.replied, previousMetrics.replied),
      createComparison('bounced', currentMetrics.bounced, previousMetrics.bounced, false),
      createComparison('openRate', currentMetrics.openRate, previousMetrics.openRate),
      createComparison('clickRate', currentMetrics.clickRate, previousMetrics.clickRate),
      createComparison('replyRate', currentMetrics.replyRate, previousMetrics.replyRate),
      createComparison('bounceRate', currentMetrics.bounceRate, previousMetrics.bounceRate, false),
    ],
  };
}

// Get email funnel data
export async function getEmailFunnel(
  workspaceId: string,
  options: {
    dateRange?: DateRange;
    timeRange?: TimeRange;
    campaignId?: string;
  } = {}
): Promise<FunnelData> {
  const counts = await countEventsByType(workspaceId, options);

  const sent = counts.email_sent || 0;
  const delivered = counts.email_delivered || 0;
  const opened = counts.email_opened || 0;
  const clicked = counts.email_clicked || 0;
  const replied = counts.email_replied || 0;

  const steps = [
    {
      name: 'Sent',
      count: sent,
      percentage: 100,
      dropoff: sent > 0 ? ((sent - delivered) / sent) * 100 : 0,
    },
    {
      name: 'Delivered',
      count: delivered,
      percentage: sent > 0 ? (delivered / sent) * 100 : 0,
      dropoff: delivered > 0 ? ((delivered - opened) / delivered) * 100 : 0,
    },
    {
      name: 'Opened',
      count: opened,
      percentage: sent > 0 ? (opened / sent) * 100 : 0,
      dropoff: opened > 0 ? ((opened - clicked) / opened) * 100 : 0,
    },
    {
      name: 'Clicked',
      count: clicked,
      percentage: sent > 0 ? (clicked / sent) * 100 : 0,
      dropoff: clicked > 0 ? ((clicked - replied) / clicked) * 100 : 0,
    },
    {
      name: 'Replied',
      count: replied,
      percentage: sent > 0 ? (replied / sent) * 100 : 0,
      dropoff: 0,
    },
  ];

  return {
    name: 'Email Engagement Funnel',
    steps,
    totalStarted: sent,
    totalCompleted: replied,
    conversionRate: sent > 0 ? (replied / sent) * 100 : 0,
  };
}

// Get breakdown by dimension
export async function getMetricBreakdown(
  workspaceId: string,
  metric: string,
  dimension: 'campaign' | 'mailbox' | 'day' | 'device' | 'country',
  options: {
    dateRange?: DateRange;
    timeRange?: TimeRange;
  } = {}
): Promise<MetricBreakdown> {
  const supabase = await createClient();
  const { dateRange } = resolveDateRange(options.dateRange, options.timeRange);

  // Map metric to event type
  const eventTypeMap: Record<string, string> = {
    opens: 'email_opened',
    clicks: 'email_clicked',
    replies: 'email_replied',
    bounces: 'email_bounced',
  };

  const eventType = eventTypeMap[metric];
  if (!eventType) {
    throw new Error(`Unknown metric: ${metric}`);
  }

  // Dimension field mapping
  const dimensionField: Record<string, string> = {
    campaign: 'campaign_id',
    mailbox: 'mailbox_id',
    day: 'created_at',
    device: 'device_type',
    country: 'country',
  };

  const field = dimensionField[dimension];

  const query = supabase
    .from('analytics_events')
    .select(field)
    .eq('workspace_id', workspaceId)
    .eq('event_type', eventType)
    .gte('created_at', dateRange.startDate.toISOString())
    .lte('created_at', dateRange.endDate.toISOString());

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  // Group by dimension
  const groups = new Map<string, number>();

  for (const row of data || []) {
    let key = row[field] as string;

    if (dimension === 'day') {
      key = new Date(key).toISOString().slice(0, 10);
    }

    key = key || 'Unknown';
    groups.set(key, (groups.get(key) || 0) + 1);
  }

  const total = Array.from(groups.values()).reduce((sum, v) => sum + v, 0);

  // Convert to breakdown items
  const items = Array.from(groups.entries())
    .map(([label, value]) => ({
      label,
      value,
      percentage: total > 0 ? (value / total) * 100 : 0,
    }))
    .sort((a, b) => b.value - a.value);

  // If campaign or mailbox, resolve names
  if (dimension === 'campaign' && items.length > 0) {
    const campaignIds = items.map((i) => i.label).filter((id) => id !== 'Unknown');
    const { data: campaigns } = await supabase
      .from('campaigns')
      .select('id, name')
      .in('id', campaignIds);

    const campaignMap = new Map(campaigns?.map((c) => [c.id, c.name]) || []);

    for (const item of items) {
      if (item.label !== 'Unknown') {
        item.label = campaignMap.get(item.label) || item.label;
      }
    }
  }

  return {
    metric,
    items,
    total,
  };
}

// Get top campaigns by metric
export async function getTopCampaigns(
  workspaceId: string,
  metric: 'opens' | 'clicks' | 'replies' | 'sent',
  options: {
    dateRange?: DateRange;
    timeRange?: TimeRange;
    limit?: number;
  } = {}
): Promise<Array<{ campaignId: string; campaignName: string; value: number }>> {
  const breakdown = await getMetricBreakdown(workspaceId, metric, 'campaign', options);

  const supabase = await createClient();
  const campaignIds = breakdown.items
    .slice(0, options.limit || 10)
    .map((i) => i.label);

  const { data: campaigns } = await supabase
    .from('campaigns')
    .select('id, name')
    .in('id', campaignIds);

  const campaignMap = new Map(campaigns?.map((c) => [c.id, c.name]) || []);

  return breakdown.items.slice(0, options.limit || 10).map((item) => ({
    campaignId: item.label,
    campaignName: campaignMap.get(item.label) || item.label,
    value: item.value,
  }));
}

// Helper: Format period key
function formatPeriodKey(date: Date, period: AggregationPeriod): string {
  switch (period) {
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
    case 'quarter':
      const quarter = Math.floor(date.getMonth() / 3) + 1;
      return `${date.getFullYear()}-Q${quarter}`;
    case 'year':
      return date.getFullYear().toString();
  }
}

// Helper: Parse period key
function parsePeriodKey(key: string, period: AggregationPeriod): Date {
  switch (period) {
    case 'hour':
      return new Date(key + ':00:00.000Z');
    case 'day':
    case 'week':
      return new Date(key + 'T00:00:00.000Z');
    case 'month':
      return new Date(key + '-01T00:00:00.000Z');
    case 'quarter':
      const [year, q] = key.split('-Q');
      const month = (parseInt(q) - 1) * 3;
      return new Date(parseInt(year), month, 1);
    case 'year':
      return new Date(parseInt(key), 0, 1);
  }
}
