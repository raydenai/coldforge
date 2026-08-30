/**
 * Warmup Pool Manager
 *
 * Manages the global warmup pool - a collection of external email accounts
 * used to send/receive warmup emails with user accounts.
 *
 * Key features:
 * - Multi-tier pools (basic, standard, premium)
 * - ESP matching (Gmail → Gmail, Outlook → Outlook) for best deliverability
 * - Health-based account selection
 * - Automatic pool maintenance and pruning
 */

import { createClient } from '@/lib/supabase/server';
import { decrypt, encrypt } from '@/lib/encryption';

// Pool account tiers with different capabilities
export type PoolTier = 'basic' | 'standard' | 'premium';

// ESP types for matching
export type ESPType =
  | 'gmail'
  | 'outlook'
  | 'yahoo'
  | 'icloud'
  | 'zoho'
  | 'fastmail'
  | 'protonmail'
  | 'custom';

// Pool account status
export type PoolAccountStatus =
  | 'active'
  | 'warming'
  | 'cooldown'
  | 'suspended'
  | 'retired';

// Pool account interface matching database schema
export interface WarmupPoolAccount {
  id: string;
  email: string;
  encrypted_credentials: string;
  esp_type: ESPType;
  tier: PoolTier;
  status: PoolAccountStatus;
  health_score: number;
  daily_send_limit: number;
  daily_receive_limit: number;
  current_daily_sends: number;
  current_daily_receives: number;
  total_sends: number;
  total_receives: number;
  total_replies: number;
  bounce_rate: number;
  spam_rate: number;
  last_send_at: string | null;
  last_receive_at: string | null;
  last_health_check: string | null;
  cooldown_until: string | null;
  created_at: string;
  metadata: Record<string, unknown>;
}

// Credentials structure for pool accounts
export interface PoolAccountCredentials {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  imapHost?: string;
  imapPort?: number;
}

// Selection criteria for finding warmup partners
export interface PartnerSelectionCriteria {
  accountId: string;
  espType: ESPType;
  tier?: PoolTier;
  count: number;
  excludeAccountIds?: string[];
  preferSameEsp?: boolean; // Default true - 70% same ESP for deliverability
  minHealthScore?: number;
}

// Pool statistics
export interface PoolStats {
  totalAccounts: number;
  activeAccounts: number;
  byTier: Record<PoolTier, number>;
  byEsp: Record<ESPType, number>;
  byStatus: Record<PoolAccountStatus, number>;
  averageHealthScore: number;
  totalDailySendsAvailable: number;
  totalDailyReceivesAvailable: number;
}

// Selection result
export interface PartnerSelection {
  account: WarmupPoolAccount;
  matchType: 'same_esp' | 'cross_esp';
  priority: number;
}

/**
 * Detect ESP type from email address
 */
export function detectESP(email: string): ESPType {
  const domain = email.split('@')[1]?.toLowerCase() || '';

  if (domain.includes('gmail') || domain.includes('googlemail')) {
    return 'gmail';
  }
  if (domain.includes('outlook') || domain.includes('hotmail') || domain.includes('live.com') || domain.includes('msn.com')) {
    return 'outlook';
  }
  if (domain.includes('yahoo') || domain.includes('ymail')) {
    return 'yahoo';
  }
  if (domain.includes('icloud') || domain.includes('me.com') || domain.includes('mac.com')) {
    return 'icloud';
  }
  if (domain.includes('zoho')) {
    return 'zoho';
  }
  if (domain.includes('fastmail')) {
    return 'fastmail';
  }
  if (domain.includes('proton') || domain.includes('pm.me')) {
    return 'protonmail';
  }

  return 'custom';
}

/**
 * Warmup Pool Manager
 *
 * Handles all operations related to the global warmup pool
 */
export class WarmupPoolManager {
  private supabase: Awaited<ReturnType<typeof createClient>> | null = null;

  // Cache for pool stats (refreshed every 5 minutes)
  private statsCache: { stats: PoolStats; timestamp: number } | null = null;
  private readonly STATS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  // ESP matching ratios for optimal deliverability
  private readonly SAME_ESP_RATIO = 0.7; // 70% same ESP
  private readonly CROSS_ESP_RATIO = 0.3; // 30% cross ESP

  /**
   * Initialize the pool manager
   */
  async initialize(): Promise<void> {
    this.supabase = await createClient();
  }

  /**
   * Ensure manager is initialized
   */
  private async ensureInitialized(): Promise<Awaited<ReturnType<typeof createClient>>> {
    if (!this.supabase) {
      await this.initialize();
    }
    return this.supabase!;
  }

  /**
   * Select optimal warmup partners for a given account
   *
   * This is the core algorithm for partner selection:
   * 1. 70% of partners should be same ESP (Gmail → Gmail) for better deliverability
   * 2. 30% cross-ESP for natural email pattern
   * 3. Prioritize high health score accounts
   * 4. Respect daily limits
   * 5. Avoid recently used partners
   */
  async selectPartners(criteria: PartnerSelectionCriteria): Promise<PartnerSelection[]> {
    const supabase = await this.ensureInitialized();

    const {
      accountId,
      espType,
      tier = 'standard',
      count,
      excludeAccountIds = [],
      preferSameEsp = true,
      minHealthScore = 70
    } = criteria;

    // Calculate how many same-ESP vs cross-ESP partners
    const sameEspCount = preferSameEsp
      ? Math.ceil(count * this.SAME_ESP_RATIO)
      : Math.floor(count * 0.5);
    const crossEspCount = count - sameEspCount;

    const selections: PartnerSelection[] = [];

    // Get same-ESP partners
    if (sameEspCount > 0) {
      const { data: sameEspAccounts, error: sameEspError } = await supabase
        .from('warmup_pool_accounts')
        .select('*')
        .eq('esp_type', espType)
        .eq('status', 'active')
        .gte('health_score', minHealthScore)
        .not('id', 'in', `(${[accountId, ...excludeAccountIds].join(',')})`)
        .gt('daily_send_limit', supabase.rpc('current_daily_sends'))
        .order('health_score', { ascending: false })
        .order('last_send_at', { ascending: true, nullsFirst: true })
        .limit(sameEspCount);

      if (!sameEspError && sameEspAccounts) {
        for (const account of sameEspAccounts) {
          selections.push({
            account: account as WarmupPoolAccount,
            matchType: 'same_esp',
            priority: 1
          });
        }
      }
    }

    // Get cross-ESP partners
    if (crossEspCount > 0 && selections.length < count) {
      const remainingCount = count - selections.length;

      const { data: crossEspAccounts, error: crossEspError } = await supabase
        .from('warmup_pool_accounts')
        .select('*')
        .neq('esp_type', espType)
        .eq('status', 'active')
        .gte('health_score', minHealthScore)
        .not('id', 'in', `(${[accountId, ...excludeAccountIds, ...selections.map(s => s.account.id)].join(',')})`)
        .order('health_score', { ascending: false })
        .order('last_send_at', { ascending: true, nullsFirst: true })
        .limit(remainingCount);

      if (!crossEspError && crossEspAccounts) {
        for (const account of crossEspAccounts) {
          selections.push({
            account: account as WarmupPoolAccount,
            matchType: 'cross_esp',
            priority: 2
          });
        }
      }
    }

    // If we still don't have enough, lower the health score requirement
    if (selections.length < count) {
      const remainingCount = count - selections.length;
      const existingIds = [accountId, ...excludeAccountIds, ...selections.map(s => s.account.id)];

      const { data: fallbackAccounts, error: fallbackError } = await supabase
        .from('warmup_pool_accounts')
        .select('*')
        .eq('status', 'active')
        .gte('health_score', 50) // Lower threshold
        .not('id', 'in', `(${existingIds.join(',')})`)
        .order('health_score', { ascending: false })
        .limit(remainingCount);

      if (!fallbackError && fallbackAccounts) {
        for (const account of fallbackAccounts) {
          selections.push({
            account: account as WarmupPoolAccount,
            matchType: account.esp_type === espType ? 'same_esp' : 'cross_esp',
            priority: 3
          });
        }
      }
    }

    return selections;
  }

  /**
   * Add a new account to the warmup pool
   */
  async addAccount(
    email: string,
    credentials: PoolAccountCredentials,
    options: {
      tier?: PoolTier;
      dailySendLimit?: number;
      dailyReceiveLimit?: number;
      metadata?: Record<string, unknown>;
    } = {}
  ): Promise<WarmupPoolAccount | null> {
    const supabase = await this.ensureInitialized();

    const espType = detectESP(email);
    const encryptedCredentials = encrypt(JSON.stringify(credentials));

    const { data, error } = await supabase
      .from('warmup_pool_accounts')
      .insert({
        email,
        encrypted_credentials: encryptedCredentials,
        esp_type: espType,
        tier: options.tier || 'standard',
        status: 'warming',
        health_score: 100,
        daily_send_limit: options.dailySendLimit || this.getDefaultDailyLimit(options.tier || 'standard'),
        daily_receive_limit: options.dailyReceiveLimit || this.getDefaultDailyLimit(options.tier || 'standard'),
        metadata: options.metadata || {}
      })
      .select()
      .single();

    if (error) {
      console.error('Failed to add pool account:', error);
      return null;
    }

    // Invalidate cache
    this.statsCache = null;

    return data as WarmupPoolAccount;
  }

  /**
   * Get default daily limit based on tier
   */
  private getDefaultDailyLimit(tier: PoolTier): number {
    switch (tier) {
      case 'premium': return 100;
      case 'standard': return 50;
      case 'basic': return 25;
      default: return 50;
    }
  }

  /**
   * Get credentials for a pool account
   */
  async getCredentials(accountId: string): Promise<PoolAccountCredentials | null> {
    const supabase = await this.ensureInitialized();

    const { data, error } = await supabase
      .from('warmup_pool_accounts')
      .select('encrypted_credentials')
      .eq('id', accountId)
      .single();

    if (error || !data) {
      return null;
    }

    try {
      const decrypted = decrypt(data.encrypted_credentials);
      return JSON.parse(decrypted) as PoolAccountCredentials;
    } catch {
      console.error('Failed to decrypt pool account credentials');
      return null;
    }
  }

  /**
   * Update account health score
   */
  async updateHealthScore(
    accountId: string,
    metrics: {
      bounceRate?: number;
      spamRate?: number;
      replyRate?: number;
      openRate?: number;
    }
  ): Promise<number> {
    const supabase = await this.ensureInitialized();

    // Calculate new health score based on metrics
    let healthScore = 100;

    // Bounce rate penalty (each 1% = -5 points)
    if (metrics.bounceRate !== undefined) {
      healthScore -= metrics.bounceRate * 5;
    }

    // Spam rate penalty (each 1% = -10 points)
    if (metrics.spamRate !== undefined) {
      healthScore -= metrics.spamRate * 10;
    }

    // Reply rate bonus (each 1% = +0.5 points, max 10 bonus)
    if (metrics.replyRate !== undefined) {
      healthScore += Math.min(metrics.replyRate * 0.5, 10);
    }

    // Ensure score is between 0 and 100
    healthScore = Math.max(0, Math.min(100, Math.round(healthScore)));

    // Update in database
    const { error } = await supabase
      .from('warmup_pool_accounts')
      .update({
        health_score: healthScore,
        bounce_rate: metrics.bounceRate,
        spam_rate: metrics.spamRate,
        last_health_check: new Date().toISOString()
      })
      .eq('id', accountId);

    if (error) {
      console.error('Failed to update health score:', error);
    }

    // Check if account should be suspended
    if (healthScore < 30) {
      await this.suspendAccount(accountId, 'Low health score');
    } else if (healthScore < 50) {
      await this.setCooldown(accountId, 24); // 24 hour cooldown
    }

    return healthScore;
  }

  /**
   * Record a send from pool account
   */
  async recordSend(accountId: string): Promise<void> {
    const supabase = await this.ensureInitialized();

    await supabase.rpc('increment_warmup_sent', { row_id: accountId });

    await supabase
      .from('warmup_pool_accounts')
      .update({
        last_send_at: new Date().toISOString(),
        current_daily_sends: supabase.rpc('increment', { value: 1 }),
        total_sends: supabase.rpc('increment', { value: 1 })
      })
      .eq('id', accountId);
  }

  /**
   * Record a receive on pool account
   */
  async recordReceive(accountId: string): Promise<void> {
    const supabase = await this.ensureInitialized();

    await supabase
      .from('warmup_pool_accounts')
      .update({
        last_receive_at: new Date().toISOString(),
        current_daily_receives: supabase.rpc('increment', { value: 1 }),
        total_receives: supabase.rpc('increment', { value: 1 })
      })
      .eq('id', accountId);
  }

  /**
   * Record a reply from pool account
   */
  async recordReply(accountId: string): Promise<void> {
    const supabase = await this.ensureInitialized();

    await supabase
      .from('warmup_pool_accounts')
      .update({
        total_replies: supabase.rpc('increment', { value: 1 })
      })
      .eq('id', accountId);
  }

  /**
   * Suspend an account
   */
  async suspendAccount(accountId: string, reason: string): Promise<void> {
    const supabase = await this.ensureInitialized();

    await supabase
      .from('warmup_pool_accounts')
      .update({
        status: 'suspended',
        metadata: supabase.rpc('jsonb_set', {
          target: 'metadata',
          path: '{suspension_reason}',
          value: JSON.stringify(reason)
        })
      })
      .eq('id', accountId);

    this.statsCache = null;
  }

  /**
   * Set cooldown period for an account
   */
  async setCooldown(accountId: string, hours: number): Promise<void> {
    const supabase = await this.ensureInitialized();

    const cooldownUntil = new Date();
    cooldownUntil.setHours(cooldownUntil.getHours() + hours);

    await supabase
      .from('warmup_pool_accounts')
      .update({
        status: 'cooldown',
        cooldown_until: cooldownUntil.toISOString()
      })
      .eq('id', accountId);

    this.statsCache = null;
  }

  /**
   * Reactivate an account from cooldown
   */
  async reactivateAccount(accountId: string): Promise<void> {
    const supabase = await this.ensureInitialized();

    await supabase
      .from('warmup_pool_accounts')
      .update({
        status: 'active',
        cooldown_until: null
      })
      .eq('id', accountId);

    this.statsCache = null;
  }

  /**
   * Get pool statistics
   */
  async getPoolStats(): Promise<PoolStats> {
    // Check cache
    if (this.statsCache && Date.now() - this.statsCache.timestamp < this.STATS_CACHE_TTL) {
      return this.statsCache.stats;
    }

    const supabase = await this.ensureInitialized();

    const { data: accounts, error } = await supabase
      .from('warmup_pool_accounts')
      .select('tier, esp_type, status, health_score, daily_send_limit, current_daily_sends, daily_receive_limit, current_daily_receives');

    if (error || !accounts) {
      throw new Error('Failed to fetch pool stats');
    }

    const stats: PoolStats = {
      totalAccounts: accounts.length,
      activeAccounts: accounts.filter(a => a.status === 'active').length,
      byTier: { basic: 0, standard: 0, premium: 0 },
      byEsp: { gmail: 0, outlook: 0, yahoo: 0, icloud: 0, zoho: 0, fastmail: 0, protonmail: 0, custom: 0 },
      byStatus: { active: 0, warming: 0, cooldown: 0, suspended: 0, retired: 0 },
      averageHealthScore: 0,
      totalDailySendsAvailable: 0,
      totalDailyReceivesAvailable: 0
    };

    let totalHealthScore = 0;

    for (const account of accounts) {
      stats.byTier[account.tier as PoolTier]++;
      stats.byEsp[account.esp_type as ESPType]++;
      stats.byStatus[account.status as PoolAccountStatus]++;
      totalHealthScore += account.health_score;

      if (account.status === 'active') {
        stats.totalDailySendsAvailable += account.daily_send_limit - account.current_daily_sends;
        stats.totalDailyReceivesAvailable += account.daily_receive_limit - account.current_daily_receives;
      }
    }

    stats.averageHealthScore = accounts.length > 0
      ? Math.round(totalHealthScore / accounts.length)
      : 0;

    // Cache the stats
    this.statsCache = { stats, timestamp: Date.now() };

    return stats;
  }

  /**
   * Prune unhealthy accounts (run daily)
   */
  async pruneUnhealthyAccounts(): Promise<{ retired: number; reactivated: number }> {
    const supabase = await this.ensureInitialized();

    let retired = 0;
    let reactivated = 0;

    // Retire accounts with persistent low health
    const { data: lowHealthAccounts, error: lowHealthError } = await supabase
      .from('warmup_pool_accounts')
      .select('id')
      .lt('health_score', 30)
      .eq('status', 'suspended')
      .lt('last_health_check', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()); // Suspended > 7 days

    if (!lowHealthError && lowHealthAccounts) {
      for (const account of lowHealthAccounts) {
        await supabase
          .from('warmup_pool_accounts')
          .update({ status: 'retired' })
          .eq('id', account.id);
        retired++;
      }
    }

    // Reactivate accounts past cooldown
    const { data: cooldownAccounts, error: cooldownError } = await supabase
      .from('warmup_pool_accounts')
      .select('id')
      .eq('status', 'cooldown')
      .lt('cooldown_until', new Date().toISOString());

    if (!cooldownError && cooldownAccounts) {
      for (const account of cooldownAccounts) {
        await this.reactivateAccount(account.id);
        reactivated++;
      }
    }

    this.statsCache = null;

    return { retired, reactivated };
  }

  /**
   * Reset daily counters (run at midnight UTC)
   */
  async resetDailyCounters(): Promise<void> {
    const supabase = await this.ensureInitialized();

    await supabase
      .from('warmup_pool_accounts')
      .update({
        current_daily_sends: 0,
        current_daily_receives: 0
      })
      .neq('status', 'retired');
  }

  /**
   * Get accounts by ESP for diagnostics
   */
  async getAccountsByESP(espType: ESPType, options: {
    status?: PoolAccountStatus;
    minHealth?: number;
    limit?: number;
  } = {}): Promise<WarmupPoolAccount[]> {
    const supabase = await this.ensureInitialized();

    let query = supabase
      .from('warmup_pool_accounts')
      .select('*')
      .eq('esp_type', espType);

    if (options.status) {
      query = query.eq('status', options.status);
    }

    if (options.minHealth !== undefined) {
      query = query.gte('health_score', options.minHealth);
    }

    query = query.order('health_score', { ascending: false });

    if (options.limit) {
      query = query.limit(options.limit);
    }

    const { data, error } = await query;

    if (error) {
      console.error('Failed to fetch accounts by ESP:', error);
      return [];
    }

    return data as WarmupPoolAccount[];
  }

  /**
   * Bulk import accounts to pool
   */
  async bulkImportAccounts(
    accounts: Array<{
      email: string;
      credentials: PoolAccountCredentials;
      tier?: PoolTier;
    }>
  ): Promise<{ imported: number; failed: number; errors: string[] }> {
    const result = { imported: 0, failed: 0, errors: [] as string[] };

    for (const account of accounts) {
      try {
        const added = await this.addAccount(
          account.email,
          account.credentials,
          { tier: account.tier }
        );

        if (added) {
          result.imported++;
        } else {
          result.failed++;
          result.errors.push(`Failed to add ${account.email}`);
        }
      } catch (error) {
        result.failed++;
        result.errors.push(`Error adding ${account.email}: ${error}`);
      }
    }

    return result;
  }
}

// Singleton instance
let poolManagerInstance: WarmupPoolManager | null = null;

export function getPoolManager(): WarmupPoolManager {
  if (!poolManagerInstance) {
    poolManagerInstance = new WarmupPoolManager();
  }
  return poolManagerInstance;
}

export async function initializePoolManager(): Promise<WarmupPoolManager> {
  const manager = getPoolManager();
  await manager.initialize();
  return manager;
}
