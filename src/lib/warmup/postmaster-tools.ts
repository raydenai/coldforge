/**
 * Google Postmaster Tools Integration
 *
 * Connects to Google Postmaster Tools API to fetch real-time
 * sender reputation data for domains sending to Gmail.
 *
 * Key metrics tracked:
 * - Domain reputation (High, Medium, Low, Bad)
 * - IP reputation
 * - Spam rate
 * - Authentication success (SPF, DKIM, DMARC)
 * - Encryption rate (TLS)
 * - Delivery errors
 */

import { createClient } from '@/lib/supabase/server';
import { google } from 'googleapis';

// Postmaster Tools API
const postmaster = google.gmailpostmastertools('v1');

// Reputation levels from Google
export type ReputationLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'BAD' | 'UNKNOWN';

// Domain reputation data
export interface DomainReputation {
  domain: string;
  date: string;
  reputation: ReputationLevel;
  spamRate: number;
  ipReputation: ReputationLevel;
  domainReputation: ReputationLevel;
  deliveryErrors: DeliveryError[];
  authentication: AuthenticationStats;
  encryption: EncryptionStats;
}

// Delivery error types
export interface DeliveryError {
  errorType: string;
  errorRatio: number;
}

// Authentication statistics
export interface AuthenticationStats {
  spfSuccessRatio: number;
  dkimSuccessRatio: number;
  dmarcSuccessRatio: number;
}

// Encryption statistics
export interface EncryptionStats {
  tlsSuccessRatio: number;
}

// Traffic stats
export interface TrafficStats {
  domain: string;
  date: string;
  userReportedSpamRatio: number;
  ipReputations: Array<{
    ip: string;
    reputation: ReputationLevel;
    sampleIps: string[];
  }>;
  domainReputation: ReputationLevel;
  spfSuccessRatio: number;
  dkimSuccessRatio: number;
  dmarcSuccessRatio: number;
  outboundEncryptionRatio: number;
  inboundEncryptionRatio: number;
  deliveryErrors: DeliveryError[];
}

// Historical reputation data
export interface ReputationHistory {
  domain: string;
  history: Array<{
    date: string;
    reputation: ReputationLevel;
    spamRate: number;
  }>;
  trend: 'improving' | 'stable' | 'declining';
  averageReputation: ReputationLevel;
}

// A single reputation alert raised by checkAlerts()
export interface ReputationAlert {
  type: string;
  message: string;
  severity: 'warning' | 'critical';
}

// Alert configuration
export interface AlertConfig {
  reputationDropThreshold: ReputationLevel;
  spamRateThreshold: number;
  authenticationThreshold: number;
  enableEmailAlerts: boolean;
  enableWebhooks: boolean;
  webhookUrl?: string;
}

// Default alert config
const DEFAULT_ALERT_CONFIG: AlertConfig = {
  reputationDropThreshold: 'LOW',
  spamRateThreshold: 1, // 1% spam rate
  authenticationThreshold: 95, // 95% success rate
  enableEmailAlerts: true,
  enableWebhooks: false
};

/**
 * Convert reputation level to numeric score
 */
export function reputationToScore(reputation: ReputationLevel): number {
  switch (reputation) {
    case 'HIGH': return 100;
    case 'MEDIUM': return 70;
    case 'LOW': return 40;
    case 'BAD': return 10;
    case 'UNKNOWN': return 50;
    default: return 50;
  }
}

/**
 * Convert numeric score to reputation level
 */
export function scoreToReputation(score: number): ReputationLevel {
  if (score >= 85) return 'HIGH';
  if (score >= 60) return 'MEDIUM';
  if (score >= 30) return 'LOW';
  if (score > 0) return 'BAD';
  return 'UNKNOWN';
}

/**
 * Google Postmaster Tools Client
 */
export class PostmasterToolsClient {
  private auth: InstanceType<typeof google.auth.OAuth2> | null = null;
  private initialized: boolean = false;
  private cachedDomains: string[] = [];
  private cacheTimestamp: number = 0;
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  constructor() {}

  /**
   * Initialize with OAuth2 credentials
   */
  async initialize(credentials: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
  }): Promise<void> {
    const oauth2Client = new google.auth.OAuth2(
      credentials.clientId,
      credentials.clientSecret
    );

    oauth2Client.setCredentials({
      refresh_token: credentials.refreshToken
    });

    this.auth = oauth2Client;
    this.initialized = true;
  }

  /**
   * Ensure client is initialized and hand back the authenticated client.
   * Returning it (rather than asserting void) lets callers pass a non-nullable
   * `auth` to googleapis, which rejects `null`.
   */
  private requireAuth(): InstanceType<typeof google.auth.OAuth2> {
    if (!this.initialized || !this.auth) {
      throw new Error('Postmaster Tools client not initialized. Call initialize() first.');
    }
    return this.auth;
  }

  /**
   * List verified domains
   */
  async listDomains(): Promise<string[]> {
    const auth = this.requireAuth();

    // Check cache
    if (this.cachedDomains.length > 0 && Date.now() - this.cacheTimestamp < this.CACHE_TTL) {
      return this.cachedDomains;
    }

    try {
      const response = await postmaster.domains.list({
        auth
      });

      const domains = response.data.domains?.map(d => d.name?.replace('domains/', '') || '') || [];

      // Update cache
      this.cachedDomains = domains;
      this.cacheTimestamp = Date.now();

      return domains;
    } catch (error) {
      console.error('Failed to list Postmaster domains:', error);
      return [];
    }
  }

  /**
   * Get traffic stats for a domain on a specific date
   */
  async getTrafficStats(domain: string, date: string): Promise<TrafficStats | null> {
    const auth = this.requireAuth();

    try {
      const response = await postmaster.domains.trafficStats.get({
        auth,
        name: `domains/${domain}/trafficStats/${date}`
      });

      const data = response.data;

      return {
        domain,
        date,
        userReportedSpamRatio: data.userReportedSpamRatio || 0,
        ipReputations: (data.ipReputations || []).map(
          (ip: { ip?: string | null; reputation?: string | null; sampleIps?: string[] | null }) => ({
            ip: ip.ip || '',
            reputation: (ip.reputation as ReputationLevel) || 'UNKNOWN',
            sampleIps: ip.sampleIps || []
          })
        ),
        domainReputation: (data.domainReputation as ReputationLevel) || 'UNKNOWN',
        spfSuccessRatio: data.spfSuccessRatio || 0,
        dkimSuccessRatio: data.dkimSuccessRatio || 0,
        dmarcSuccessRatio: data.dmarcSuccessRatio || 0,
        outboundEncryptionRatio: data.outboundEncryptionRatio || 0,
        inboundEncryptionRatio: data.inboundEncryptionRatio || 0,
        deliveryErrors: (data.deliveryErrors || []).map(
          (e: { errorType?: string | null; errorRatio?: number | null }) => ({
            errorType: e.errorType || 'UNKNOWN',
            errorRatio: e.errorRatio || 0
          })
        )
      };
    } catch (error) {
      console.error(`Failed to get traffic stats for ${domain}:`, error);
      return null;
    }
  }

  /**
   * Get domain reputation summary
   */
  async getDomainReputation(domain: string): Promise<DomainReputation | null> {
    const today = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const stats = await this.getTrafficStats(domain, today);

    if (!stats) {
      // Try yesterday if today's data not available
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
        .toISOString().split('T')[0].replace(/-/g, '');
      const yesterdayStats = await this.getTrafficStats(domain, yesterday);

      if (!yesterdayStats) {
        return null;
      }

      return this.trafficStatsToReputation(yesterdayStats);
    }

    return this.trafficStatsToReputation(stats);
  }

  /**
   * Convert traffic stats to reputation data
   */
  private trafficStatsToReputation(stats: TrafficStats): DomainReputation {
    // Calculate overall IP reputation
    let ipReputation: ReputationLevel = 'UNKNOWN';
    if (stats.ipReputations.length > 0) {
      const avgScore = stats.ipReputations.reduce(
        (sum, ip) => sum + reputationToScore(ip.reputation),
        0
      ) / stats.ipReputations.length;
      ipReputation = scoreToReputation(avgScore);
    }

    return {
      domain: stats.domain,
      date: stats.date,
      reputation: stats.domainReputation,
      spamRate: stats.userReportedSpamRatio * 100,
      ipReputation,
      domainReputation: stats.domainReputation,
      deliveryErrors: stats.deliveryErrors,
      authentication: {
        spfSuccessRatio: stats.spfSuccessRatio * 100,
        dkimSuccessRatio: stats.dkimSuccessRatio * 100,
        dmarcSuccessRatio: stats.dmarcSuccessRatio * 100
      },
      encryption: {
        tlsSuccessRatio: stats.outboundEncryptionRatio * 100
      }
    };
  }

  /**
   * Get reputation history for last N days
   */
  async getReputationHistory(domain: string, days: number = 30): Promise<ReputationHistory> {
    this.requireAuth();

    const history: ReputationHistory['history'] = [];

    for (let i = 0; i < days; i++) {
      const date = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const dateStr = date.toISOString().split('T')[0].replace(/-/g, '');

      const stats = await this.getTrafficStats(domain, dateStr);

      if (stats) {
        history.push({
          date: dateStr,
          reputation: stats.domainReputation,
          spamRate: stats.userReportedSpamRatio * 100
        });
      }
    }

    // Calculate trend
    let trend: ReputationHistory['trend'] = 'stable';
    if (history.length >= 7) {
      const recentAvg = history.slice(0, 7).reduce(
        (sum, h) => sum + reputationToScore(h.reputation),
        0
      ) / 7;
      const olderAvg = history.slice(7, 14).reduce(
        (sum, h) => sum + reputationToScore(h.reputation),
        0
      ) / Math.min(7, history.length - 7);

      if (recentAvg > olderAvg + 10) {
        trend = 'improving';
      } else if (recentAvg < olderAvg - 10) {
        trend = 'declining';
      }
    }

    // Calculate average reputation
    const avgScore = history.length > 0
      ? history.reduce((sum, h) => sum + reputationToScore(h.reputation), 0) / history.length
      : 50;

    return {
      domain,
      history,
      trend,
      averageReputation: scoreToReputation(avgScore)
    };
  }

  /**
   * Check for reputation alerts
   */
  async checkAlerts(
    domain: string,
    config: AlertConfig = DEFAULT_ALERT_CONFIG
  ): Promise<Array<{ type: string; message: string; severity: 'warning' | 'critical' }>> {
    const reputation = await this.getDomainReputation(domain);
    const alerts: ReputationAlert[] = [];

    if (!reputation) {
      return [{
        type: 'data_unavailable',
        message: `No reputation data available for ${domain}`,
        severity: 'warning'
      }];
    }

    // Check domain reputation
    const currentScore = reputationToScore(reputation.reputation);
    const thresholdScore = reputationToScore(config.reputationDropThreshold);

    if (currentScore <= thresholdScore) {
      alerts.push({
        type: 'low_reputation',
        message: `Domain reputation is ${reputation.reputation} for ${domain}`,
        severity: reputation.reputation === 'BAD' ? 'critical' : 'warning'
      });
    }

    // Check spam rate
    if (reputation.spamRate > config.spamRateThreshold) {
      alerts.push({
        type: 'high_spam_rate',
        message: `Spam rate is ${reputation.spamRate.toFixed(2)}% (threshold: ${config.spamRateThreshold}%)`,
        severity: reputation.spamRate > config.spamRateThreshold * 2 ? 'critical' : 'warning'
      });
    }

    // Check authentication
    if (reputation.authentication.spfSuccessRatio < config.authenticationThreshold) {
      alerts.push({
        type: 'low_spf',
        message: `SPF success rate is ${reputation.authentication.spfSuccessRatio.toFixed(1)}%`,
        severity: 'warning'
      });
    }

    if (reputation.authentication.dkimSuccessRatio < config.authenticationThreshold) {
      alerts.push({
        type: 'low_dkim',
        message: `DKIM success rate is ${reputation.authentication.dkimSuccessRatio.toFixed(1)}%`,
        severity: 'warning'
      });
    }

    if (reputation.authentication.dmarcSuccessRatio < config.authenticationThreshold) {
      alerts.push({
        type: 'low_dmarc',
        message: `DMARC success rate is ${reputation.authentication.dmarcSuccessRatio.toFixed(1)}%`,
        severity: 'warning'
      });
    }

    // Check delivery errors
    for (const error of reputation.deliveryErrors) {
      if (error.errorRatio > 0.01) { // More than 1% error rate
        alerts.push({
          type: 'delivery_error',
          message: `${error.errorType} affecting ${(error.errorRatio * 100).toFixed(2)}% of emails`,
          severity: error.errorRatio > 0.05 ? 'critical' : 'warning'
        });
      }
    }

    return alerts;
  }

  /**
   * Store reputation data in database
   */
  async storeReputationData(accountId: string, reputation: DomainReputation): Promise<void> {
    const supabase = await createClient();

    await supabase
      .from('sender_reputation')
      .insert({
        account_id: accountId,
        source: 'google_postmaster',
        overall_score: reputationToScore(reputation.reputation),
        deliverability_score: reputationToScore(reputation.domainReputation),
        engagement_score: 100 - reputation.spamRate, // Inverse of spam rate
        spam_score: reputation.spamRate,
        bounce_rate: 0, // Not available from Postmaster
        raw_data: reputation
      });
  }

  /**
   * Sync all domains reputation data
   */
  async syncAllDomains(): Promise<{
    synced: number;
    failed: number;
    alerts: Array<{ domain: string; alerts: ReputationAlert[] }>;
  }> {
    const domains = await this.listDomains();
    const result = {
      synced: 0,
      failed: 0,
      alerts: [] as Array<{ domain: string; alerts: ReputationAlert[] }>
    };

    for (const domain of domains) {
      try {
        const reputation = await this.getDomainReputation(domain);

        if (reputation) {
          // Store in database (need to find account by domain)
          const supabase = await createClient();
          const { data: accounts } = await supabase
            .from('email_accounts')
            .select('id')
            .ilike('email', `%@${domain}`);

          if (accounts) {
            for (const account of accounts) {
              await this.storeReputationData(account.id, reputation);
            }
          }

          // Check for alerts
          const alerts = await this.checkAlerts(domain);
          if (alerts.length > 0) {
            result.alerts.push({ domain, alerts });
          }

          result.synced++;
        } else {
          result.failed++;
        }
      } catch (error) {
        console.error(`Failed to sync domain ${domain}:`, error);
        result.failed++;
      }
    }

    return result;
  }
}

// Singleton instance
let clientInstance: PostmasterToolsClient | null = null;

export function getPostmasterClient(): PostmasterToolsClient {
  if (!clientInstance) {
    clientInstance = new PostmasterToolsClient();
  }
  return clientInstance;
}

/**
 * Initialize Postmaster Tools from environment
 */
export async function initializePostmasterTools(): Promise<PostmasterToolsClient | null> {
  const clientId = process.env.GOOGLE_POSTMASTER_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_POSTMASTER_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_POSTMASTER_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    console.warn('Google Postmaster Tools credentials not configured');
    return null;
  }

  const client = getPostmasterClient();
  await client.initialize({
    clientId,
    clientSecret,
    refreshToken
  });

  return client;
}

/**
 * Get reputation summary for dashboard
 */
export async function getReputationSummary(accountId: string): Promise<{
  current: DomainReputation | null;
  history: ReputationHistory | null;
  alerts: ReputationAlert[];
  lastUpdated: string;
}> {
  const supabase = await createClient();

  // Get account's domain
  const { data: account } = await supabase
    .from('email_accounts')
    .select('email')
    .eq('id', accountId)
    .single();

  if (!account) {
    return {
      current: null,
      history: null,
      alerts: [],
      lastUpdated: new Date().toISOString()
    };
  }

  const domain = account.email.split('@')[1];
  const client = getPostmasterClient();

  try {
    const current = await client.getDomainReputation(domain);
    const history = await client.getReputationHistory(domain, 14);
    const alerts = await client.checkAlerts(domain);

    // Store current reputation
    if (current) {
      await client.storeReputationData(accountId, current);
    }

    return {
      current,
      history,
      alerts,
      lastUpdated: new Date().toISOString()
    };
  } catch (error) {
    console.error('Failed to get reputation summary:', error);

    // Return last stored data
    const { data: lastRep } = await supabase
      .from('sender_reputation')
      .select('*')
      .eq('account_id', accountId)
      .eq('source', 'google_postmaster')
      .order('recorded_at', { ascending: false })
      .limit(1)
      .single();

    return {
      current: lastRep?.raw_data || null,
      history: null,
      alerts: [],
      lastUpdated: lastRep?.recorded_at || new Date().toISOString()
    };
  }
}
