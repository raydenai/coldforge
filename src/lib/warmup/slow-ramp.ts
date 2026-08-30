/**
 * Slow Ramp Controller
 *
 * Implements gradual email volume increase to build sender reputation.
 * The core principle: Start slow, increase by 1 email/day, never rush.
 *
 * Key features:
 * - Configurable ramp profiles (conservative, moderate, aggressive)
 * - Automatic pause on reputation issues
 * - Daily limit calculations based on account age
 * - Weekend/holiday adjustments for natural patterns
 */

import { createClient } from '@/lib/supabase/server';

// Ramp profiles with different acceleration rates
export type RampProfile = 'conservative' | 'moderate' | 'aggressive';

// Ramp configuration
export interface RampConfig {
  profile: RampProfile;
  startingVolume: number;
  maxDailyVolume: number;
  dailyIncrement: number;
  weekendReduction: number; // Percentage reduction on weekends
  healthPauseThreshold: number; // Pause if health drops below this
  bounceRatePause: number; // Pause if bounce rate exceeds this
  spamRatePause: number; // Pause if spam rate exceeds this
  minEngagementRate: number; // Required engagement to continue ramping
}

// Ramp status
export interface RampStatus {
  accountId: string;
  currentDay: number;
  currentVolume: number;
  maxVolume: number;
  targetVolume: number;
  profile: RampProfile;
  isPaused: boolean;
  pauseReason: string | null;
  lastRampAt: string | null;
  nextRampAt: string;
  healthScore: number;
  metrics: {
    totalSent: number;
    totalDelivered: number;
    totalOpened: number;
    totalReplied: number;
    totalBounced: number;
    totalSpammed: number;
    deliveryRate: number;
    openRate: number;
    replyRate: number;
    bounceRate: number;
    spamRate: number;
  };
}

// Ramp schedule entry
export interface RampScheduleEntry {
  day: number;
  volume: number;
  date: string;
  status: 'completed' | 'current' | 'scheduled' | 'paused';
  actualSent?: number;
  actualDelivered?: number;
}

// Shapes of the database rows this module reads.
//
// Declared locally because `warmup_sessions`, `warmup_daily_stats` and the
// account-reputation table are among the tables missing from the generated
// `src/types/database.ts` (see docs/BASELINE-FND-001.md). Replace these with the
// generated Row types once schema and types are reconciled.
export interface WarmupSessionRow {
  started_at: string;
  last_activity_at?: string | null;
}

export interface WarmupDailyStatRow {
  emails_sent?: number | null;
  emails_delivered?: number | null;
  emails_opened?: number | null;
  emails_replied?: number | null;
  bounces?: number | null;
  spam_reports?: number | null;
}

export interface AccountReputationRow {
  overall_score?: number | null;
}

// Default ramp profiles
export const RAMP_PROFILES: Record<RampProfile, Omit<RampConfig, 'maxDailyVolume'>> = {
  conservative: {
    profile: 'conservative',
    startingVolume: 2,
    dailyIncrement: 1,
    weekendReduction: 50,
    healthPauseThreshold: 70,
    bounceRatePause: 3,
    spamRatePause: 1,
    minEngagementRate: 10
  },
  moderate: {
    profile: 'moderate',
    startingVolume: 5,
    dailyIncrement: 2,
    weekendReduction: 40,
    healthPauseThreshold: 60,
    bounceRatePause: 5,
    spamRatePause: 2,
    minEngagementRate: 8
  },
  aggressive: {
    profile: 'aggressive',
    startingVolume: 10,
    dailyIncrement: 3,
    weekendReduction: 30,
    healthPauseThreshold: 50,
    bounceRatePause: 7,
    spamRatePause: 3,
    minEngagementRate: 5
  }
};

/**
 * Calculate volume for a specific day with weekend adjustment
 */
export function calculateDayVolume(
  config: RampConfig,
  day: number,
  isWeekend: boolean
): number {
  // Base volume: starting + (days * increment)
  let volume = config.startingVolume + (day - 1) * config.dailyIncrement;

  // Cap at max
  volume = Math.min(volume, config.maxDailyVolume);

  // Weekend reduction
  if (isWeekend) {
    volume = Math.floor(volume * (1 - config.weekendReduction / 100));
    volume = Math.max(volume, 1); // At least 1 email
  }

  return volume;
}

/**
 * Check if a date is a weekend
 */
export function isWeekend(date: Date = new Date()): boolean {
  const day = date.getDay();
  return day === 0 || day === 6;
}

/**
 * Check if a date is a major holiday (simplified)
 */
export function isHoliday(date: Date = new Date()): boolean {
  const month = date.getMonth();
  const day = date.getDate();

  // Major US holidays (simplified)
  const holidays = [
    { month: 0, day: 1 },   // New Year's Day
    { month: 6, day: 4 },   // Independence Day
    { month: 10, day: 25 }, // Thanksgiving (approximate)
    { month: 11, day: 25 }, // Christmas
    { month: 11, day: 31 }, // New Year's Eve
  ];

  return holidays.some(h => h.month === month && h.day === day);
}

/**
 * Generate ramp schedule for an account
 */
export function generateRampSchedule(
  config: RampConfig,
  startDate: Date = new Date(),
  days: number = 30
): RampScheduleEntry[] {
  const schedule: RampScheduleEntry[] = [];

  for (let i = 0; i < days; i++) {
    const date = new Date(startDate);
    date.setDate(date.getDate() + i);

    const weekend = isWeekend(date);
    const holiday = isHoliday(date);

    let volume = calculateDayVolume(config, i + 1, weekend);

    // Further reduce on holidays
    if (holiday) {
      volume = Math.floor(volume * 0.5);
      volume = Math.max(volume, 1);
    }

    schedule.push({
      day: i + 1,
      volume,
      date: date.toISOString().split('T')[0],
      status: i === 0 ? 'current' : 'scheduled'
    });
  }

  return schedule;
}

/**
 * Slow Ramp Controller Class
 */
export class SlowRampController {
  private supabase: Awaited<ReturnType<typeof createClient>> | null = null;
  private config: RampConfig;

  constructor(config?: Partial<RampConfig>) {
    this.config = {
      ...RAMP_PROFILES.moderate,
      maxDailyVolume: 50,
      ...config
    };
  }

  /**
   * Initialize the controller
   */
  async initialize(): Promise<void> {
    this.supabase = await createClient();
  }

  /**
   * Ensure initialized
   */
  private async ensureInitialized(): Promise<Awaited<ReturnType<typeof createClient>>> {
    if (!this.supabase) {
      await this.initialize();
    }
    return this.supabase!;
  }

  /**
   * Get or create warmup schedule for an account
   */
  async getSchedule(accountId: string): Promise<RampScheduleEntry[]> {
    const supabase = await this.ensureInitialized();

    // Check for existing schedule
    const { data: existing, error } = await supabase
      .from('warmup_schedules')
      .select('*')
      .eq('account_id', accountId)
      .order('day_number', { ascending: true });

    if (!error && existing && existing.length > 0) {
      return existing.map(e => ({
        day: e.day_number,
        volume: e.target_volume,
        date: e.scheduled_date,
        status: e.status,
        actualSent: e.actual_sent,
        actualDelivered: e.actual_delivered
      }));
    }

    // Generate new schedule
    const schedule = generateRampSchedule(this.config);

    // Save to database
    const scheduleRecords = schedule.map(entry => ({
      account_id: accountId,
      day_number: entry.day,
      scheduled_date: entry.date,
      target_volume: entry.volume,
      status: entry.status
    }));

    await supabase
      .from('warmup_schedules')
      .insert(scheduleRecords);

    return schedule;
  }

  /**
   * Get current day's target volume
   */
  async getTodayVolume(accountId: string): Promise<number> {
    const supabase = await this.ensureInitialized();
    const today = new Date().toISOString().split('T')[0];

    // Check for pauses first
    const status = await this.getRampStatus(accountId);
    if (status.isPaused) {
      return 0;
    }

    // Get today's schedule entry
    const { data, error } = await supabase
      .from('warmup_schedules')
      .select('target_volume')
      .eq('account_id', accountId)
      .eq('scheduled_date', today)
      .single();

    if (error || !data) {
      // No schedule for today, calculate based on day
      const session = await this.getWarmupSession(accountId);
      if (!session) {
        return this.config.startingVolume;
      }

      const startDate = new Date(session.started_at);
      const dayNumber = Math.floor((Date.now() - startDate.getTime()) / (24 * 60 * 60 * 1000)) + 1;

      return calculateDayVolume(this.config, dayNumber, isWeekend());
    }

    return data.target_volume;
  }

  /**
   * Get warmup session for account
   */
  private async getWarmupSession(accountId: string): Promise<WarmupSessionRow | null> {
    const supabase = await this.ensureInitialized();

    const { data, error } = await supabase
      .from('warmup_sessions')
      .select('*')
      .eq('account_id', accountId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    // Boundary cast: `warmup_sessions` is absent from the generated Database
    // type, so supabase-js cannot infer this row. Remove once schema and types
    // are reconciled (docs/BASELINE-FND-001.md).
    return error ? null : (data as unknown as WarmupSessionRow);
  }

  /**
   * Get comprehensive ramp status
   */
  async getRampStatus(accountId: string): Promise<RampStatus> {
    const supabase = await this.ensureInitialized();

    // Get session
    const session = await this.getWarmupSession(accountId);

    // Get today's schedule
    const schedule = await this.getSchedule(accountId);
    const today = new Date().toISOString().split('T')[0];
    const todayEntry = schedule.find(e => e.date === today);

    // Get reputation data
    const { data: reputation } = await supabase
      .from('sender_reputation')
      .select('*')
      .eq('account_id', accountId)
      .order('recorded_at', { ascending: false })
      .limit(1)
      .single();

    // Get daily stats
    const { data: dailyStats } = await supabase
      .from('warmup_daily_stats')
      .select('*')
      .eq('account_id', accountId)
      .order('date', { ascending: false })
      .limit(7);

    // Calculate aggregated metrics.
    // Boundary cast: `warmup_daily_stats` is absent from the generated Database
    // type (docs/BASELINE-FND-001.md).
    const metrics = this.calculateMetrics((dailyStats || []) as unknown as WarmupDailyStatRow[]);

    // Determine if paused and why.
    // Boundary cast: `sender_reputation` is absent from the generated Database
    // type (docs/BASELINE-FND-001.md).
    const { isPaused, pauseReason } = this.checkPauseConditions(
      (reputation as unknown as AccountReputationRow | null) ?? null,
      metrics
    );

    // Calculate day number
    const dayNumber = session
      ? Math.floor((Date.now() - new Date(session.started_at).getTime()) / (24 * 60 * 60 * 1000)) + 1
      : 1;

    return {
      accountId,
      currentDay: dayNumber,
      currentVolume: todayEntry?.volume || this.config.startingVolume,
      maxVolume: this.config.maxDailyVolume,
      targetVolume: calculateDayVolume(this.config, dayNumber + 1, false),
      profile: this.config.profile,
      isPaused,
      pauseReason,
      lastRampAt: session?.last_activity_at || null,
      nextRampAt: this.getNextRampDate(schedule),
      healthScore: reputation?.overall_score || 100,
      metrics
    };
  }

  /**
   * Calculate aggregated metrics from daily stats
   */
  private calculateMetrics(dailyStats: WarmupDailyStatRow[]): RampStatus['metrics'] {
    const totals = {
      sent: 0,
      delivered: 0,
      opened: 0,
      replied: 0,
      bounced: 0,
      spammed: 0
    };

    for (const day of dailyStats) {
      totals.sent += day.emails_sent || 0;
      totals.delivered += day.emails_delivered || 0;
      totals.opened += day.emails_opened || 0;
      totals.replied += day.emails_replied || 0;
      totals.bounced += day.bounces || 0;
      totals.spammed += day.spam_reports || 0;
    }

    return {
      totalSent: totals.sent,
      totalDelivered: totals.delivered,
      totalOpened: totals.opened,
      totalReplied: totals.replied,
      totalBounced: totals.bounced,
      totalSpammed: totals.spammed,
      deliveryRate: totals.sent > 0 ? (totals.delivered / totals.sent) * 100 : 100,
      openRate: totals.delivered > 0 ? (totals.opened / totals.delivered) * 100 : 0,
      replyRate: totals.delivered > 0 ? (totals.replied / totals.delivered) * 100 : 0,
      bounceRate: totals.sent > 0 ? (totals.bounced / totals.sent) * 100 : 0,
      spamRate: totals.sent > 0 ? (totals.spammed / totals.sent) * 100 : 0
    };
  }

  /**
   * Check if warmup should be paused
   */
  private checkPauseConditions(
    reputation: AccountReputationRow | null,
    metrics: RampStatus['metrics']
  ): { isPaused: boolean; pauseReason: string | null } {
    // Check health score. An unknown reputation is treated as healthy, matching
    // getRampStatus(); previously this relied on `undefined < threshold` being
    // false, which only worked because the parameter was untyped.
    const healthScore = reputation?.overall_score ?? 100;
    if (healthScore < this.config.healthPauseThreshold) {
      return {
        isPaused: true,
        pauseReason: `Health score dropped to ${healthScore}% (threshold: ${this.config.healthPauseThreshold}%)`
      };
    }

    // Check bounce rate
    if (metrics.bounceRate > this.config.bounceRatePause) {
      return {
        isPaused: true,
        pauseReason: `Bounce rate at ${metrics.bounceRate.toFixed(1)}% (threshold: ${this.config.bounceRatePause}%)`
      };
    }

    // Check spam rate
    if (metrics.spamRate > this.config.spamRatePause) {
      return {
        isPaused: true,
        pauseReason: `Spam rate at ${metrics.spamRate.toFixed(1)}% (threshold: ${this.config.spamRatePause}%)`
      };
    }

    // Check engagement rate after enough data
    if (metrics.totalDelivered > 50) {
      const engagementRate = ((metrics.totalOpened + metrics.totalReplied) / metrics.totalDelivered) * 100;
      if (engagementRate < this.config.minEngagementRate) {
        return {
          isPaused: true,
          pauseReason: `Engagement rate at ${engagementRate.toFixed(1)}% (minimum: ${this.config.minEngagementRate}%)`
        };
      }
    }

    return { isPaused: false, pauseReason: null };
  }

  /**
   * Get next scheduled ramp date
   */
  private getNextRampDate(schedule: RampScheduleEntry[]): string {
    const today = new Date().toISOString().split('T')[0];
    const nextEntry = schedule.find(e => e.date > today && e.status === 'scheduled');
    return nextEntry?.date || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  }

  /**
   * Update daily progress
   */
  async updateDailyProgress(
    accountId: string,
    sent: number,
    delivered: number
  ): Promise<void> {
    const supabase = await this.ensureInitialized();
    const today = new Date().toISOString().split('T')[0];

    // Update schedule entry
    await supabase
      .from('warmup_schedules')
      .update({
        actual_sent: sent,
        actual_delivered: delivered,
        status: 'completed'
      })
      .eq('account_id', accountId)
      .eq('scheduled_date', today);

    // Mark next day as current
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    await supabase
      .from('warmup_schedules')
      .update({ status: 'current' })
      .eq('account_id', accountId)
      .eq('scheduled_date', tomorrow);
  }

  /**
   * Pause warmup for account
   */
  async pauseWarmup(accountId: string, reason: string): Promise<void> {
    const supabase = await this.ensureInitialized();

    await supabase
      .from('warmup_sessions')
      .update({
        status: 'paused',
        pause_reason: reason,
        paused_at: new Date().toISOString()
      })
      .eq('account_id', accountId)
      .eq('status', 'active');

    // Mark remaining schedule entries as paused
    await supabase
      .from('warmup_schedules')
      .update({ status: 'paused' })
      .eq('account_id', accountId)
      .eq('status', 'scheduled');
  }

  /**
   * Resume warmup for account
   */
  async resumeWarmup(accountId: string): Promise<void> {
    const supabase = await this.ensureInitialized();

    await supabase
      .from('warmup_sessions')
      .update({
        status: 'active',
        pause_reason: null,
        paused_at: null,
        resumed_at: new Date().toISOString()
      })
      .eq('account_id', accountId)
      .eq('status', 'paused');

    // Resume schedule - regenerate from today
    await this.regenerateSchedule(accountId);
  }

  /**
   * Regenerate schedule from today
   */
  async regenerateSchedule(accountId: string): Promise<void> {
    const supabase = await this.ensureInitialized();
    const today = new Date().toISOString().split('T')[0];

    // Delete future schedule entries
    await supabase
      .from('warmup_schedules')
      .delete()
      .eq('account_id', accountId)
      .gte('scheduled_date', today);

    // Get current day number from session
    const session = await this.getWarmupSession(accountId);
    const startDate = session ? new Date(session.started_at) : new Date();
    const currentDay = Math.floor((Date.now() - startDate.getTime()) / (24 * 60 * 60 * 1000)) + 1;

    // Generate new schedule from current day
    const schedule = generateRampSchedule(
      { ...this.config, startingVolume: calculateDayVolume(this.config, currentDay, false) },
      new Date(),
      30
    );

    // Save new schedule
    const scheduleRecords = schedule.map((entry, idx) => ({
      account_id: accountId,
      day_number: currentDay + idx,
      scheduled_date: entry.date,
      target_volume: entry.volume,
      status: idx === 0 ? 'current' : 'scheduled'
    }));

    await supabase
      .from('warmup_schedules')
      .insert(scheduleRecords);
  }

  /**
   * Adjust ramp profile
   */
  async adjustProfile(accountId: string, profile: RampProfile): Promise<void> {
    this.config = {
      ...RAMP_PROFILES[profile],
      maxDailyVolume: this.config.maxDailyVolume
    };

    await this.regenerateSchedule(accountId);
  }

  /**
   * Get recommended profile based on account history
   */
  async getRecommendedProfile(accountId: string): Promise<RampProfile> {
    const status = await this.getRampStatus(accountId);

    // New accounts should be conservative
    if (status.currentDay < 7) {
      return 'conservative';
    }

    // Check historical performance
    if (status.metrics.bounceRate < 1 && status.metrics.spamRate < 0.5 && status.healthScore > 90) {
      return 'aggressive';
    }

    if (status.metrics.bounceRate < 3 && status.metrics.spamRate < 1 && status.healthScore > 75) {
      return 'moderate';
    }

    return 'conservative';
  }

  /**
   * Calculate days to reach target volume
   */
  calculateDaysToTarget(targetVolume: number): number {
    if (targetVolume <= this.config.startingVolume) {
      return 0;
    }

    return Math.ceil((targetVolume - this.config.startingVolume) / this.config.dailyIncrement);
  }

  /**
   * Get sending windows for natural patterns
   */
  getSendingWindows(timezone: string = 'America/New_York'): Array<{ start: number; end: number; weight: number }> {
    // Business hours with weighted distribution
    return [
      { start: 8, end: 10, weight: 0.25 },   // Morning rush
      { start: 10, end: 12, weight: 0.20 },  // Late morning
      { start: 13, end: 15, weight: 0.25 },  // Afternoon
      { start: 15, end: 17, weight: 0.20 },  // Late afternoon
      { start: 17, end: 19, weight: 0.10 }   // Evening
    ];
  }

  /**
   * Get optimal send time within window
   */
  getOptimalSendTime(window: { start: number; end: number }): Date {
    const now = new Date();
    const hour = window.start + Math.random() * (window.end - window.start);
    const minute = Math.floor(Math.random() * 60);

    now.setHours(Math.floor(hour), minute, 0, 0);

    return now;
  }
}

// Factory function
export function createSlowRampController(config?: Partial<RampConfig>): SlowRampController {
  return new SlowRampController(config);
}

// Default instance
let defaultController: SlowRampController | null = null;

export function getSlowRampController(): SlowRampController {
  if (!defaultController) {
    defaultController = new SlowRampController();
  }
  return defaultController;
}
