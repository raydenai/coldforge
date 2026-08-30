// Email Queue Processor
// Handles queuing, processing, and retry logic for email sending

import { createClient } from '../supabase/server';
import { decrypt } from '../encryption';
import { sendEmail, verifyProvider } from './client';
import {
  claimSendSlot,
  markDispatched,
  releaseSendClaim,
  buildAdHocKey,
} from '@/lib/compliance/send-eligibility';
import type {
  QueuedEmail,
  QueueStatus,
  SmtpProviderConfig,
  EmailMessage,
  SendResult,
} from './types';

// Queue email for sending
export async function queueEmail(
  email: Omit<QueuedEmail, 'id' | 'status' | 'attempts' | 'maxAttempts'>
): Promise<{ success: boolean; queueId?: string; error?: string }> {
  try {
    const supabase = await createClient();

    const { data, error } = await supabase
      .from('email_queue')
      .insert({
        workspace_id: email.workspaceId,
        campaign_id: email.campaignId,
        sequence_id: email.sequenceId,
        sequence_step: email.sequenceStep,
        from_mailbox_id: email.fromMailboxId,
        from_email: email.fromEmail,
        from_name: email.fromName,
        reply_to: email.replyTo,
        to_email: email.toEmail,
        to_name: email.toName,
        lead_id: email.leadId,
        subject: email.subject,
        body_html: email.bodyHtml,
        body_text: email.bodyText,
        custom_headers: email.customHeaders || {},
        tracking_id: email.trackingId,
        attachments: email.attachments || [],
        smtp_provider_id: email.smtpProviderId,
        assigned_ip: email.assignedIp,
        scheduled_at: email.scheduledAt.toISOString(),
        send_window_start: email.sendWindowStart,
        send_window_end: email.sendWindowEnd,
        timezone: email.timezone || 'UTC',
        status: 'pending',
        priority: email.priority || 5,
        attempts: 0,
        max_attempts: 3,
      })
      .select('id')
      .single();

    if (error) {
      return { success: false, error: error.message };
    }

    return { success: true, queueId: data.id };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to queue email',
    };
  }
}

// Queue multiple emails
export async function queueBulkEmails(
  emails: Omit<QueuedEmail, 'id' | 'status' | 'attempts' | 'maxAttempts'>[]
): Promise<{ success: boolean; count: number; errors: string[] }> {
  const errors: string[] = [];
  let count = 0;

  for (const email of emails) {
    const result = await queueEmail(email);
    if (result.success) {
      count++;
    } else {
      errors.push(`${email.toEmail}: ${result.error}`);
    }
  }

  return {
    success: errors.length === 0,
    count,
    errors,
  };
}

// Get next emails to process
export async function getNextEmailsToProcess(
  limit: number = 50,
  workspaceId?: string
): Promise<QueuedEmail[]> {
  const supabase = await createClient();

  let query = supabase
    .from('email_queue')
    .select('*')
    .in('status', ['pending', 'scheduled'])
    .lte('scheduled_at', new Date().toISOString())
    .lt('attempts', 3)
    .order('priority', { ascending: true })
    .order('scheduled_at', { ascending: true })
    .limit(limit);

  if (workspaceId) {
    query = query.eq('workspace_id', workspaceId);
  }

  const { data, error } = await query;

  if (error || !data) return [];

  return data.map(transformQueuedEmail);
}

// Get emails pending retry
export async function getEmailsForRetry(limit: number = 20): Promise<QueuedEmail[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('email_queue')
    .select('*')
    .eq('status', 'failed')
    .lt('attempts', 3)
    .lte('next_retry_at', new Date().toISOString())
    .order('next_retry_at', { ascending: true })
    .limit(limit);

  if (error || !data) return [];

  return data.map(transformQueuedEmail);
}

// Transform database row to typed object
function transformQueuedEmail(row: Record<string, unknown>): QueuedEmail {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    campaignId: row.campaign_id as string | undefined,
    sequenceId: row.sequence_id as string | undefined,
    sequenceStep: row.sequence_step as number | undefined,
    fromMailboxId: row.from_mailbox_id as string,
    fromEmail: row.from_email as string,
    fromName: row.from_name as string | undefined,
    replyTo: row.reply_to as string | undefined,
    toEmail: row.to_email as string,
    toName: row.to_name as string | undefined,
    leadId: row.lead_id as string | undefined,
    subject: row.subject as string,
    bodyHtml: row.body_html as string,
    bodyText: row.body_text as string | undefined,
    customHeaders: row.custom_headers as Record<string, string> | undefined,
    trackingId: row.tracking_id as string | undefined,
    smtpProviderId: row.smtp_provider_id as string | undefined,
    assignedIp: row.assigned_ip as string | undefined,
    scheduledAt: new Date(row.scheduled_at as string),
    sendWindowStart: row.send_window_start as string | undefined,
    sendWindowEnd: row.send_window_end as string | undefined,
    timezone: row.timezone as string,
    status: row.status as QueueStatus,
    priority: row.priority as number,
    attempts: row.attempts as number,
    maxAttempts: row.max_attempts as number,
    lastAttemptAt: row.last_attempt_at ? new Date(row.last_attempt_at as string) : undefined,
    nextRetryAt: row.next_retry_at ? new Date(row.next_retry_at as string) : undefined,
    sentAt: row.sent_at ? new Date(row.sent_at as string) : undefined,
    deliveredAt: row.delivered_at ? new Date(row.delivered_at as string) : undefined,
    messageId: row.message_id as string | undefined,
    errorCode: row.error_code as string | undefined,
    errorMessage: row.error_message as string | undefined,
  };
}

// Get SMTP provider for sending
async function getSmtpProvider(
  workspaceId: string,
  providerId?: string
): Promise<SmtpProviderConfig | null> {
  const supabase = await createClient();

  let query = supabase
    .from('smtp_providers')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('is_active', true)
    .eq('is_healthy', true);

  if (providerId) {
    query = query.eq('id', providerId);
  } else {
    // Get provider with available quota
    query = query
      .order('priority', { ascending: true })
      .limit(1);
  }

  const { data, error } = await query.single();

  if (error || !data) return null;

  // Decrypt credentials
  let credentials;
  if (data.username_encrypted && data.password_encrypted) {
    credentials = {
      host: data.host,
      port: data.port,
      username: decrypt(data.username_encrypted),
      password: decrypt(data.password_encrypted),
    };
  }

  let apiCredentials;
  if (data.api_key_encrypted) {
    apiCredentials = {
      apiKey: decrypt(data.api_key_encrypted),
      apiSecret: data.api_secret_encrypted ? decrypt(data.api_secret_encrypted) : undefined,
      region: data.region,
      endpoint: data.endpoint,
    };
  }

  return {
    id: data.id,
    workspaceId: data.workspace_id,
    name: data.name,
    providerType: data.provider_type,
    credentials,
    apiCredentials,
    config: data.config,
    isActive: data.is_active,
    isHealthy: data.is_healthy,
    priority: data.priority,
    rateLimits: {
      maxPerSecond: data.max_per_second,
      maxPerMinute: data.max_per_minute,
      maxPerHour: data.max_per_hour,
      maxPerDay: data.max_per_day,
    },
  };
}

// Update queue status
async function updateQueueStatus(
  queueId: string,
  status: QueueStatus,
  result?: SendResult
): Promise<void> {
  const supabase = await createClient();

  const updates: Record<string, unknown> = {
    status,
    attempts: supabase.rpc('increment', { x: 1 }),
    last_attempt_at: new Date().toISOString(),
  };

  if (status === 'sent') {
    updates.sent_at = new Date().toISOString();
    updates.message_id = result?.messageId;
  } else if (status === 'failed') {
    updates.error_code = result?.errorCode;
    updates.error_message = result?.error;
    // Calculate next retry (exponential backoff)
    const attempts = 1; // Would need current attempts + 1
    const delayMinutes = Math.pow(2, attempts) * 5; // 5, 10, 20, 40...
    updates.next_retry_at = new Date(Date.now() + delayMinutes * 60 * 1000).toISOString();
  }

  await supabase
    .from('email_queue')
    .update(updates)
    .eq('id', queueId);
}

// Check if email is suppressed
async function isEmailSuppressed(
  email: string,
  workspaceId: string
): Promise<boolean> {
  const supabase = await createClient();

  const { data } = await supabase
    .from('email_suppressions')
    .select('id')
    .eq('email', email.toLowerCase())
    .eq('is_active', true)
    .or(`workspace_id.is.null,workspace_id.eq.${workspaceId}`)
    .limit(1)
    .single();

  return !!data;
}

// Process a single queued email
export async function processQueuedEmail(
  queuedEmail: QueuedEmail
): Promise<SendResult> {
  // Defence in depth, layer 1: cheap suppression read.
  // Kept deliberately. It short-circuits the common case without an RPC, and it
  // keeps working if migration 019 has not been applied yet.
  const suppressed = await isEmailSuppressed(queuedEmail.toEmail, queuedEmail.workspaceId);
  if (suppressed) {
    await updateQueueStatus(queuedEmail.id, 'cancelled', {
      success: false,
      error: 'Email is suppressed',
      timestamp: new Date(),
    });
    return {
      success: false,
      error: 'Email is suppressed',
      timestamp: new Date(),
    };
  }

  // Defence in depth, layer 2: atomic check-and-claim (SEC-006, CAM-004).
  //
  // Layer 1 alone is a time-of-check/time-of-use gap: a suppression written
  // between that SELECT and this send would be missed. This closes the gap
  // between check and claim, and the unique idempotency key makes a redelivered
  // job refuse rather than send twice.
  //
  // REQUIRES migration 019_send_eligibility.sql. Fails closed if absent.
  const claim = await claimSendSlot({
    idempotencyKey: buildAdHocKey('reply', queuedEmail.id, 'queue'),
    email: queuedEmail.toEmail,
    workspaceId: queuedEmail.workspaceId,
  });

  if (!claim.allowed) {
    // 'duplicate' means another worker already owns this touch — cancelling is
    // correct, and deliberately not a retry.
    await updateQueueStatus(queuedEmail.id, 'cancelled', {
      success: false,
      error: `Send refused: ${claim.reason}`,
      timestamp: new Date(),
    });
    return {
      success: false,
      error: `Send refused: ${claim.reason}`,
      timestamp: new Date(),
    };
  }

  // Get SMTP provider
  const provider = await getSmtpProvider(
    queuedEmail.workspaceId,
    queuedEmail.smtpProviderId
  );

  if (!provider) {
    await updateQueueStatus(queuedEmail.id, 'failed', {
      success: false,
      error: 'No available SMTP provider',
      timestamp: new Date(),
    });
    return {
      success: false,
      error: 'No available SMTP provider',
      timestamp: new Date(),
    };
  }

  // Prepare message
  const message: EmailMessage = {
    from: {
      email: queuedEmail.fromEmail,
      name: queuedEmail.fromName,
    },
    to: {
      email: queuedEmail.toEmail,
      name: queuedEmail.toName,
    },
    replyTo: queuedEmail.replyTo,
    subject: queuedEmail.subject,
    html: queuedEmail.bodyHtml,
    text: queuedEmail.bodyText,
    headers: queuedEmail.customHeaders,
    trackingId: queuedEmail.trackingId,
  };

  // Mark as processing
  const supabase = await createClient();
  await supabase
    .from('email_queue')
    .update({
      status: 'processing',
      smtp_provider_id: provider.id,
    })
    .eq('id', queuedEmail.id);

  // Send email
  const result = await sendEmail(provider, message);

  // Close out the claim. On success the claim becomes the durable record that
  // this touch was dispatched; on failure it is released so a retry is not
  // permanently blocked by its own idempotency key.
  if (result.success) {
    await markDispatched(claim.idempotencyKey, result.messageId);
  } else {
    await releaseSendClaim(claim.idempotencyKey);
  }

  // Update status
  await updateQueueStatus(
    queuedEmail.id,
    result.success ? 'sent' : 'failed',
    result
  );

  // Record event
  if (result.success) {
    await supabase.from('email_events').insert({
      workspace_id: queuedEmail.workspaceId,
      email_queue_id: queuedEmail.id,
      campaign_id: queuedEmail.campaignId,
      message_id: result.messageId,
      tracking_id: queuedEmail.trackingId,
      event_type: 'sent',
      recipient_email: queuedEmail.toEmail,
      lead_id: queuedEmail.leadId,
      occurred_at: new Date().toISOString(),
    });
  }

  return result;
}

// Process batch of emails
export async function processEmailBatch(
  limit: number = 50
): Promise<{ processed: number; successful: number; failed: number }> {
  const emails = await getNextEmailsToProcess(limit);

  let successful = 0;
  let failed = 0;

  for (const email of emails) {
    const result = await processQueuedEmail(email);
    if (result.success) {
      successful++;
    } else {
      failed++;
    }

    // Small delay to prevent rate limiting
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  return {
    processed: emails.length,
    successful,
    failed,
  };
}

// Get queue stats
export async function getQueueStats(
  workspaceId: string
): Promise<{
  pending: number;
  processing: number;
  sent: number;
  failed: number;
  cancelled: number;
}> {
  const supabase = await createClient();

  const statuses = ['pending', 'processing', 'sent', 'failed', 'cancelled'];
  const stats: Record<string, number> = {};

  for (const status of statuses) {
    const { count } = await supabase
      .from('email_queue')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('status', status);

    stats[status] = count || 0;
  }

  return stats as {
    pending: number;
    processing: number;
    sent: number;
    failed: number;
    cancelled: number;
  };
}

// Cancel queued emails
export async function cancelQueuedEmails(
  queueIds: string[],
  workspaceId: string
): Promise<{ cancelled: number }> {
  const supabase = await createClient();

  const { data } = await supabase
    .from('email_queue')
    .update({ status: 'cancelled' })
    .eq('workspace_id', workspaceId)
    .in('id', queueIds)
    .in('status', ['pending', 'scheduled'])
    .select('id');

  return { cancelled: data?.length || 0 };
}

// Retry failed emails
export async function retryFailedEmails(
  workspaceId: string
): Promise<{ retried: number }> {
  const supabase = await createClient();

  const { data } = await supabase
    .from('email_queue')
    .update({
      status: 'pending',
      next_retry_at: null,
    })
    .eq('workspace_id', workspaceId)
    .eq('status', 'failed')
    .lt('attempts', 3)
    .select('id');

  return { retried: data?.length || 0 };
}
