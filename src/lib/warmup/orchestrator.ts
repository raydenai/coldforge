/**
 * Warmup Orchestrator
 *
 * The central coordinator for the entire warmup system.
 * Manages all warmup operations, scheduling, monitoring, and optimization.
 *
 * Key responsibilities:
 * - Coordinate warmup sessions between user accounts and pool accounts
 * - Manage daily warmup execution
 * - Monitor reputation and auto-pause on issues
 * - Handle engagement simulation
 * - Track and report on warmup progress
 */

import { Queue, Worker, Job } from 'bullmq';
import { createClient } from '@/lib/supabase/server';
import { getPoolManager, WarmupPoolAccount, PartnerSelection, ESPType, detectESP } from './pool-manager';
import { getSlowRampController, RampStatus } from './slow-ramp';
import { generateAIReply, GeneratedReply } from './ai-replies';
import { getEngagementEngine, EngagementAction } from './engagement-engine';
import { getPostmasterClient, DomainReputation } from './postmaster-tools';
import { createTransporter, sendEmail } from '@/lib/sending/sender';
import { decrypt } from '@/lib/encryption';
import type { UpdateTables } from '@/types/database';

// Redis connection for BullMQ
const redisConnection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD
};

// Queue names
const QUEUE_NAMES = {
  warmupSend: 'warmup-send',
  warmupReceive: 'warmup-receive',
  warmupEngage: 'warmup-engage',
  warmupRescue: 'warmup-rescue',
  reputationCheck: 'reputation-check'
};

// Warmup session status
export type WarmupSessionStatus =
  | 'active'
  | 'paused'
  | 'completed'
  | 'failed';

// Warmup session
export interface WarmupSession {
  id: string;
  accountId: string;
  organizationId: string;
  status: WarmupSessionStatus;
  startedAt: string;
  currentDay: number;
  targetVolume: number;
  currentVolume: number;
  totalSent: number;
  totalReceived: number;
  totalOpened: number;
  totalReplied: number;
  totalRescued: number;
  healthScore: number;
  pauseReason?: string;
  lastActivityAt: string;
}

// Warmup task
export interface WarmupTask {
  type: 'send' | 'receive' | 'engage' | 'rescue';
  accountId: string;
  poolAccountId?: string;
  emailId?: string;
  subject?: string;
  body?: string;
  scheduledAt: string;
  priority: number;
}

// Warmup execution result
export interface WarmupExecutionResult {
  success: boolean;
  taskType: string;
  accountId: string;
  emailId?: string;
  duration: number;
  error?: string;
  metrics?: {
    delivered?: boolean;
    opened?: boolean;
    replied?: boolean;
    rescued?: boolean;
  };
}

// Daily warmup summary
export interface DailyWarmupSummary {
  accountId: string;
  date: string;
  targetVolume: number;
  actualSent: number;
  actualReceived: number;
  opened: number;
  replied: number;
  rescued: number;
  bounced: number;
  spammed: number;
  healthScore: number;
  completionRate: number;
}

/**
 * Warmup Orchestrator Class
 */
export class WarmupOrchestrator {
  private sendQueue: Queue;
  private receiveQueue: Queue;
  private engageQueue: Queue;
  private rescueQueue: Queue;
  private reputationQueue: Queue;

  private sendWorker: Worker | null = null;
  private receiveWorker: Worker | null = null;
  private engageWorker: Worker | null = null;
  private rescueWorker: Worker | null = null;
  private reputationWorker: Worker | null = null;

  private isRunning: boolean = false;

  constructor() {
    // Initialize queues
    this.sendQueue = new Queue(QUEUE_NAMES.warmupSend, { connection: redisConnection });
    this.receiveQueue = new Queue(QUEUE_NAMES.warmupReceive, { connection: redisConnection });
    this.engageQueue = new Queue(QUEUE_NAMES.warmupEngage, { connection: redisConnection });
    this.rescueQueue = new Queue(QUEUE_NAMES.warmupRescue, { connection: redisConnection });
    this.reputationQueue = new Queue(QUEUE_NAMES.reputationCheck, { connection: redisConnection });
  }

  /**
   * Start the orchestrator
   */
  async start(): Promise<void> {
    if (this.isRunning) return;

    // Start workers
    this.sendWorker = new Worker(
      QUEUE_NAMES.warmupSend,
      async (job) => this.processSendJob(job),
      {
        connection: redisConnection,
        concurrency: 5,
        limiter: { max: 10, duration: 1000 } // 10 per second
      }
    );

    this.receiveWorker = new Worker(
      QUEUE_NAMES.warmupReceive,
      async (job) => this.processReceiveJob(job),
      {
        connection: redisConnection,
        concurrency: 5
      }
    );

    this.engageWorker = new Worker(
      QUEUE_NAMES.warmupEngage,
      async (job) => this.processEngageJob(job),
      {
        connection: redisConnection,
        concurrency: 2 // Limited due to browser resources
      }
    );

    this.rescueWorker = new Worker(
      QUEUE_NAMES.warmupRescue,
      async (job) => this.processRescueJob(job),
      {
        connection: redisConnection,
        concurrency: 1 // Sequential for safety
      }
    );

    this.reputationWorker = new Worker(
      QUEUE_NAMES.reputationCheck,
      async (job) => this.processReputationJob(job),
      {
        connection: redisConnection,
        concurrency: 3
      }
    );

    // Set up error handlers
    this.setupErrorHandlers();

    this.isRunning = true;
    console.log('Warmup Orchestrator started');
  }

  /**
   * Stop the orchestrator
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    await this.sendWorker?.close();
    await this.receiveWorker?.close();
    await this.engageWorker?.close();
    await this.rescueWorker?.close();
    await this.reputationWorker?.close();

    await this.sendQueue.close();
    await this.receiveQueue.close();
    await this.engageQueue.close();
    await this.rescueQueue.close();
    await this.reputationQueue.close();

    this.isRunning = false;
    console.log('Warmup Orchestrator stopped');
  }

  /**
   * Set up error handlers for workers
   */
  private setupErrorHandlers(): void {
    const workers = [
      this.sendWorker,
      this.receiveWorker,
      this.engageWorker,
      this.rescueWorker,
      this.reputationWorker
    ];

    for (const worker of workers) {
      worker?.on('failed', (job, error) => {
        console.error(`Job ${job?.id} failed:`, error);
      });

      worker?.on('error', (error) => {
        console.error('Worker error:', error);
      });
    }
  }

  /**
   * Start warmup for an account
   */
  async startWarmup(accountId: string, options: {
    targetVolume?: number;
    profile?: 'conservative' | 'moderate' | 'aggressive';
  } = {}): Promise<WarmupSession> {
    const supabase = await createClient();

    // Get account details
    const { data: account, error: accountError } = await supabase
      .from('email_accounts')
      .select('*, organizations(id)')
      .eq('id', accountId)
      .single();

    if (accountError || !account) {
      throw new Error('Account not found');
    }

    // Check for existing active session
    const { data: existingSession } = await supabase
      .from('warmup_sessions')
      .select('*')
      .eq('account_id', accountId)
      .eq('status', 'active')
      .single();

    if (existingSession) {
      return existingSession as WarmupSession;
    }

    // Create new session
    const { data: session, error: sessionError } = await supabase
      .from('warmup_sessions')
      .insert({
        account_id: accountId,
        organization_id: account.organization_id,
        status: 'active',
        target_daily_volume: options.targetVolume || 50,
        current_daily_volume: 0,
        warmup_score: 100
      })
      .select()
      .single();

    if (sessionError || !session) {
      throw new Error('Failed to create warmup session');
    }

    // Initialize slow ramp controller
    const rampController = getSlowRampController();
    await rampController.getSchedule(accountId);

    // Update account warmup status
    await supabase
      .from('email_accounts')
      .update({ warmup_enabled: true })
      .eq('id', accountId);

    // Schedule first day's warmup
    await this.scheduleDailyWarmup(accountId);

    return {
      id: session.id,
      accountId: session.account_id,
      organizationId: session.organization_id,
      status: session.status,
      startedAt: session.created_at,
      currentDay: 1,
      targetVolume: session.target_daily_volume,
      currentVolume: session.current_daily_volume,
      totalSent: 0,
      totalReceived: 0,
      totalOpened: 0,
      totalReplied: 0,
      totalRescued: 0,
      healthScore: session.warmup_score,
      lastActivityAt: session.last_activity_at || session.created_at
    };
  }

  /**
   * Stop warmup for an account
   */
  async stopWarmup(accountId: string, reason?: string): Promise<void> {
    const supabase = await createClient();

    // Update session
    await supabase
      .from('warmup_sessions')
      .update({
        status: 'completed',
        completed_at: new Date().toISOString(),
        pause_reason: reason || 'Manual stop'
      })
      .eq('account_id', accountId)
      .eq('status', 'active');

    // Update account
    await supabase
      .from('email_accounts')
      .update({ warmup_enabled: false })
      .eq('id', accountId);

    // Cancel pending jobs
    const jobs = await this.sendQueue.getJobs(['waiting', 'delayed']);
    for (const job of jobs) {
      if (job.data.accountId === accountId) {
        await job.remove();
      }
    }
  }

  /**
   * Pause warmup for an account
   */
  async pauseWarmup(accountId: string, reason: string): Promise<void> {
    const supabase = await createClient();
    const rampController = getSlowRampController();

    await rampController.pauseWarmup(accountId, reason);

    await supabase
      .from('warmup_sessions')
      .update({
        status: 'paused',
        pause_reason: reason,
        paused_at: new Date().toISOString()
      })
      .eq('account_id', accountId)
      .eq('status', 'active');
  }

  /**
   * Resume warmup for an account
   */
  async resumeWarmup(accountId: string): Promise<void> {
    const supabase = await createClient();
    const rampController = getSlowRampController();

    await rampController.resumeWarmup(accountId);

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

    // Resume daily scheduling
    await this.scheduleDailyWarmup(accountId);
  }

  /**
   * Schedule daily warmup tasks for an account
   */
  async scheduleDailyWarmup(accountId: string): Promise<void> {
    const supabase = await createClient();
    const poolManager = getPoolManager();
    const rampController = getSlowRampController();

    // Get today's volume
    const volume = await rampController.getTodayVolume(accountId);

    if (volume === 0) {
      console.log(`Warmup paused for account ${accountId}`);
      return;
    }

    // Get account details
    const { data: account } = await supabase
      .from('email_accounts')
      .select('email')
      .eq('id', accountId)
      .single();

    if (!account) return;

    const espType = detectESP(account.email);

    // Select pool partners
    await poolManager.initialize();
    const partners = await poolManager.selectPartners({
      accountId,
      espType,
      count: volume,
      preferSameEsp: true,
      minHealthScore: 70
    });

    if (partners.length === 0) {
      console.error(`No pool partners available for account ${accountId}`);
      return;
    }

    // Get sending windows
    const windows = rampController.getSendingWindows();

    // Distribute emails across the day
    const emailsPerWindow = Math.ceil(volume / windows.length);

    for (let i = 0; i < volume; i++) {
      const windowIndex = Math.floor(i / emailsPerWindow) % windows.length;
      const window = windows[windowIndex];
      const partner = partners[i % partners.length];

      // Calculate send time
      const sendTime = rampController.getOptimalSendTime(window);

      // Add jitter
      sendTime.setMinutes(sendTime.getMinutes() + Math.floor(Math.random() * 30));

      // Schedule send job
      await this.sendQueue.add(
        'warmup-send',
        {
          type: 'send',
          accountId,
          poolAccountId: partner.account.id,
          direction: 'outbound',
          scheduledAt: sendTime.toISOString()
        },
        {
          delay: sendTime.getTime() - Date.now(),
          priority: partner.priority,
          removeOnComplete: 100,
          removeOnFail: 100
        }
      );

      // Schedule receive job (pool account sends back)
      const receiveTime = new Date(sendTime.getTime() + 30 * 60 * 1000 + Math.random() * 60 * 60 * 1000);

      await this.receiveQueue.add(
        'warmup-receive',
        {
          type: 'receive',
          accountId,
          poolAccountId: partner.account.id,
          direction: 'inbound',
          scheduledAt: receiveTime.toISOString()
        },
        {
          delay: receiveTime.getTime() - Date.now(),
          priority: 2,
          removeOnComplete: 100,
          removeOnFail: 100
        }
      );

      // Schedule engagement (open, reply with probability)
      if (Math.random() > 0.3) { // 70% open rate
        const engageTime = new Date(receiveTime.getTime() + 5 * 60 * 1000 + Math.random() * 30 * 60 * 1000);

        await this.engageQueue.add(
          'warmup-engage',
          {
            type: 'engage',
            accountId,
            poolAccountId: partner.account.id,
            action: Math.random() > 0.5 ? 'open' : 'reply',
            scheduledAt: engageTime.toISOString()
          },
          {
            delay: engageTime.getTime() - Date.now(),
            priority: 3,
            removeOnComplete: 100,
            removeOnFail: 100
          }
        );
      }
    }

    console.log(`Scheduled ${volume} warmup emails for account ${accountId}`);
  }

  /**
   * Process send job
   */
  private async processSendJob(job: Job): Promise<WarmupExecutionResult> {
    const startTime = Date.now();
    const { accountId, poolAccountId, direction } = job.data;

    const supabase = await createClient();
    const poolManager = getPoolManager();

    try {
      // Get accounts
      const { data: userAccount } = await supabase
        .from('email_accounts')
        .select('email, encrypted_credentials, smtp_host, smtp_port')
        .eq('id', accountId)
        .single();

      await poolManager.initialize();
      const poolCredentials = await poolManager.getCredentials(poolAccountId);
      const { data: poolAccount } = await supabase
        .from('warmup_pool_accounts')
        .select('email')
        .eq('id', poolAccountId)
        .single();

      if (!userAccount || !poolCredentials || !poolAccount) {
        throw new Error('Account or pool account not found');
      }

      // Determine sender and recipient based on direction
      let sender, recipient, senderCreds;
      if (direction === 'outbound') {
        sender = userAccount;
        recipient = poolAccount;
        senderCreds = JSON.parse(decrypt(userAccount.encrypted_credentials));
      } else {
        sender = poolAccount;
        recipient = userAccount;
        senderCreds = poolCredentials;
      }

      // Generate warmup content using AI
      const reply = await generateAIReply({
        originalSubject: '',
        originalBody: '',
        senderName: sender.email.split('@')[0],
        recipientName: recipient.email.split('@')[0],
        tone: 'professional'
      });

      // Create transporter
      const transporter = createTransporter({
        host: senderCreds.host || userAccount.smtp_host,
        port: senderCreds.port || userAccount.smtp_port || 587,
        secure: senderCreds.secure ?? true,
        auth: {
          user: senderCreds.user,
          pass: senderCreds.pass
        }
      });

      // Send email
      const result = await sendEmail(transporter, {
        subject: reply.subject || `Re: Quick question about ${this.getRandomTopic()}`,
        html: `<p>${reply.body}</p>`,
        text: reply.body
      }, {
        from: sender.email,
        to: recipient.email,
        replyTo: sender.email
      });

      // Record in database
      const { data: warmupEmail } = await supabase
        .from('warmup_emails')
        .insert({
          user_account_id: accountId,
          pool_account_id: poolAccountId,
          direction,
          subject: reply.subject,
          message_id: result.messageId,
          sent_at: new Date().toISOString(),
          status: 'sent'
        })
        .select()
        .single();

      // Update stats
      if (direction === 'outbound') {
        await supabase.rpc('increment_warmup_sent', { row_id: accountId });
        await poolManager.recordReceive(poolAccountId);
      } else {
        await supabase.rpc('increment_warmup_received', { row_id: accountId });
        await poolManager.recordSend(poolAccountId);
      }

      return {
        success: true,
        taskType: 'send',
        accountId,
        emailId: warmupEmail?.id,
        duration: Date.now() - startTime,
        metrics: { delivered: true }
      };
    } catch (error) {
      console.error('Warmup send failed:', error);

      return {
        success: false,
        taskType: 'send',
        accountId,
        duration: Date.now() - startTime,
        error: (error as Error).message
      };
    }
  }

  /**
   * Process receive job
   */
  private async processReceiveJob(job: Job): Promise<WarmupExecutionResult> {
    // Receive jobs are essentially send jobs from pool to user
    return this.processSendJob({
      ...job,
      data: { ...job.data, direction: 'inbound' }
    } as Job);
  }

  /**
   * Process engagement job
   */
  private async processEngageJob(job: Job): Promise<WarmupExecutionResult> {
    const startTime = Date.now();
    const { accountId, poolAccountId, action } = job.data;

    const supabase = await createClient();

    try {
      const engagementEngine = getEngagementEngine();

      // Get the latest email to engage with
      const { data: email } = await supabase
        .from('warmup_emails')
        .select('*')
        .eq('user_account_id', accountId)
        .eq('pool_account_id', poolAccountId)
        .eq('direction', 'inbound')
        .order('sent_at', { ascending: false })
        .limit(1)
        .single();

      if (!email) {
        return {
          success: false,
          taskType: 'engage',
          accountId,
          duration: Date.now() - startTime,
          error: 'No email to engage with'
        };
      }

      // For now, simulate engagement without browser automation
      // In production, use the engagement engine
      const simulatedOpen = Math.random() > 0.2;
      const simulatedReply = action === 'reply' && Math.random() > 0.4;

      // Update email record
      const updates: UpdateTables<'warmup_emails'> = {};
      if (simulatedOpen) {
        updates.opened_at = new Date().toISOString();
        updates.status = 'opened';
        await supabase.rpc('increment_warmup_opened', { row_id: accountId });
      }
      if (simulatedReply) {
        updates.replied_at = new Date().toISOString();
        updates.status = 'replied';
        await supabase.rpc('increment_warmup_replied', { row_id: accountId });
      }

      await supabase
        .from('warmup_emails')
        .update(updates)
        .eq('id', email.id);

      return {
        success: true,
        taskType: 'engage',
        accountId,
        emailId: email.id,
        duration: Date.now() - startTime,
        metrics: {
          opened: simulatedOpen,
          replied: simulatedReply
        }
      };
    } catch (error) {
      return {
        success: false,
        taskType: 'engage',
        accountId,
        duration: Date.now() - startTime,
        error: (error as Error).message
      };
    }
  }

  /**
   * Process rescue job
   */
  private async processRescueJob(job: Job): Promise<WarmupExecutionResult> {
    const startTime = Date.now();
    const { accountId } = job.data;

    try {
      const engagementEngine = getEngagementEngine();
      const result = await engagementEngine.executeSpamRescue(accountId, 3);

      return {
        success: result.rescued > 0,
        taskType: 'rescue',
        accountId,
        duration: Date.now() - startTime,
        metrics: { rescued: result.rescued > 0 }
      };
    } catch (error) {
      return {
        success: false,
        taskType: 'rescue',
        accountId,
        duration: Date.now() - startTime,
        error: (error as Error).message
      };
    }
  }

  /**
   * Process reputation check job
   */
  private async processReputationJob(job: Job): Promise<void> {
    const { accountId } = job.data;

    const supabase = await createClient();

    try {
      const postmasterClient = getPostmasterClient();

      // Get account domain
      const { data: account } = await supabase
        .from('email_accounts')
        .select('email')
        .eq('id', accountId)
        .single();

      if (!account) return;

      const domain = account.email.split('@')[1];

      // Get reputation
      const reputation = await postmasterClient.getDomainReputation(domain);

      if (reputation) {
        // Store reputation data
        await postmasterClient.storeReputationData(accountId, reputation);

        // Check for alerts
        const alerts = await postmasterClient.checkAlerts(domain);

        // Auto-pause if critical alerts
        const criticalAlerts = alerts.filter(a => a.severity === 'critical');
        if (criticalAlerts.length > 0) {
          await this.pauseWarmup(
            accountId,
            `Critical reputation issue: ${criticalAlerts.map(a => a.message).join(', ')}`
          );
        }
      }
    } catch (error) {
      console.error('Reputation check failed:', error);
    }
  }

  /**
   * Get warmup status for an account
   */
  async getWarmupStatus(accountId: string): Promise<{
    session: WarmupSession | null;
    ramp: RampStatus;
    reputation: DomainReputation | null;
    todayStats: DailyWarmupSummary | null;
  }> {
    const supabase = await createClient();
    const rampController = getSlowRampController();
    const postmasterClient = getPostmasterClient();

    // Get session
    const { data: session } = await supabase
      .from('warmup_sessions')
      .select('*')
      .eq('account_id', accountId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    // Get ramp status
    await rampController.initialize();
    const ramp = await rampController.getRampStatus(accountId);

    // Get reputation
    const { data: account } = await supabase
      .from('email_accounts')
      .select('email')
      .eq('id', accountId)
      .single();

    let reputation: DomainReputation | null = null;
    if (account) {
      const domain = account.email.split('@')[1];
      try {
        reputation = await postmasterClient.getDomainReputation(domain);
      } catch {
        // Postmaster may not be configured
      }
    }

    // Get today's stats
    const today = new Date().toISOString().split('T')[0];
    const { data: todayStats } = await supabase
      .from('warmup_daily_stats')
      .select('*')
      .eq('account_id', accountId)
      .eq('date', today)
      .single();

    return {
      session: session ? {
        id: session.id,
        accountId: session.account_id,
        organizationId: session.organization_id,
        status: session.status,
        startedAt: session.created_at,
        currentDay: ramp.currentDay,
        targetVolume: session.target_daily_volume,
        currentVolume: session.current_daily_volume,
        totalSent: session.total_sent || 0,
        totalReceived: session.total_received || 0,
        totalOpened: session.total_opened || 0,
        totalReplied: session.total_replied || 0,
        totalRescued: session.total_rescued || 0,
        healthScore: session.warmup_score,
        pauseReason: session.pause_reason,
        lastActivityAt: session.last_activity_at || session.created_at
      } : null,
      ramp,
      reputation,
      todayStats: todayStats ? {
        accountId: todayStats.account_id,
        date: todayStats.date,
        targetVolume: ramp.currentVolume,
        actualSent: todayStats.emails_sent,
        actualReceived: todayStats.emails_received,
        opened: todayStats.emails_opened,
        replied: todayStats.emails_replied,
        rescued: todayStats.spam_rescued,
        bounced: todayStats.bounces,
        spammed: todayStats.spam_reports,
        healthScore: todayStats.health_score,
        completionRate: todayStats.emails_sent / ramp.currentVolume * 100
      } : null
    };
  }

  /**
   * Get random topic for email subject
   */
  private getRandomTopic(): string {
    const topics = [
      'the project',
      'our discussion',
      'next steps',
      'the meeting',
      'your feedback',
      'the proposal',
      'our call',
      'the update',
      'the review',
      'our partnership'
    ];
    return topics[Math.floor(Math.random() * topics.length)];
  }

  /**
   * Run daily maintenance tasks
   */
  async runDailyMaintenance(): Promise<void> {
    const supabase = await createClient();
    const poolManager = getPoolManager();

    // Reset daily counters
    await poolManager.initialize();
    await poolManager.resetDailyCounters();

    // Prune unhealthy accounts
    await poolManager.pruneUnhealthyAccounts();

    // Get all active warmup accounts
    const { data: activeAccounts } = await supabase
      .from('warmup_sessions')
      .select('account_id')
      .eq('status', 'active');

    if (!activeAccounts) return;

    // Schedule daily warmup for each
    for (const { account_id } of activeAccounts) {
      await this.scheduleDailyWarmup(account_id);

      // Schedule reputation check
      await this.reputationQueue.add(
        'reputation-check',
        { accountId: account_id },
        { delay: Math.random() * 60 * 60 * 1000 } // Random within first hour
      );
    }

    console.log(`Daily maintenance complete. Scheduled warmup for ${activeAccounts.length} accounts`);
  }
}

// Singleton instance
let orchestratorInstance: WarmupOrchestrator | null = null;

export function getWarmupOrchestrator(): WarmupOrchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new WarmupOrchestrator();
  }
  return orchestratorInstance;
}

export async function initializeWarmupOrchestrator(): Promise<WarmupOrchestrator> {
  const orchestrator = getWarmupOrchestrator();
  await orchestrator.start();
  return orchestrator;
}
