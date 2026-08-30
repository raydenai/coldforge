// Developer Webhooks
import { createClient } from '@/lib/supabase/server';
import crypto from 'crypto';
import type {
  DeveloperWebhook,
  DeveloperWebhookEvent,
  WebhookPayload,
  WebhookDeliveryAttempt,
  CURRENT_API_VERSION,
} from './types';

// Constants
const MAX_RETRY_ATTEMPTS = 5;
const RETRY_DELAYS = [0, 60, 300, 1800, 7200]; // seconds: immediate, 1min, 5min, 30min, 2hr
const WEBHOOK_TIMEOUT = 30000; // 30 seconds

// Generate webhook secret
function generateWebhookSecret(): string {
  return `whsec_${crypto.randomBytes(32).toString('hex')}`;
}

// Create signature for webhook payload
export function signWebhookPayload(payload: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signaturePayload = `${timestamp}.${payload}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(signaturePayload)
    .digest('hex');

  return `t=${timestamp},v1=${signature}`;
}

// Verify webhook signature
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
  tolerance: number = 300 // 5 minutes
): boolean {
  const elements = signature.split(',');
  const timestamp = elements.find((e) => e.startsWith('t='))?.slice(2);
  const sig = elements.find((e) => e.startsWith('v1='))?.slice(3);

  if (!timestamp || !sig) {
    return false;
  }

  const timestampNum = parseInt(timestamp);
  const now = Math.floor(Date.now() / 1000);

  // Check timestamp tolerance
  if (Math.abs(now - timestampNum) > tolerance) {
    return false;
  }

  // Verify signature
  const signaturePayload = `${timestamp}.${payload}`;
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(signaturePayload)
    .digest('hex');

  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig));
}

// Create Developer Webhook
export async function createDeveloperWebhook(
  workspaceId: string,
  options: {
    name: string;
    url: string;
    events: DeveloperWebhookEvent[];
    version?: string;
  }
): Promise<DeveloperWebhook> {
  const supabase = await createClient();
  const secret = generateWebhookSecret();

  const { data, error } = await supabase
    .from('developer_webhooks')
    .insert({
      workspace_id: workspaceId,
      name: options.name,
      url: options.url,
      secret,
      events: options.events,
      is_active: true,
      version: options.version || '2025-01-01',
    })
    .select()
    .single();

  if (error) throw error;

  return mapDeveloperWebhook(data);
}

// Get Developer Webhook
export async function getDeveloperWebhook(
  webhookId: string
): Promise<DeveloperWebhook | null> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('developer_webhooks')
    .select('*')
    .eq('id', webhookId)
    .single();

  if (error || !data) return null;

  return mapDeveloperWebhook(data);
}

// List Developer Webhooks
export async function listDeveloperWebhooks(
  workspaceId: string
): Promise<DeveloperWebhook[]> {
  const supabase = await createClient();

  const { data, error } = await supabase
    .from('developer_webhooks')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false });

  if (error) throw error;

  return (data || []).map(mapDeveloperWebhook);
}

// Update Developer Webhook
export async function updateDeveloperWebhook(
  webhookId: string,
  updates: {
    name?: string;
    url?: string;
    events?: DeveloperWebhookEvent[];
    isActive?: boolean;
  }
): Promise<DeveloperWebhook> {
  const supabase = await createClient();

  const updateData: Record<string, unknown> = {};
  if (updates.name !== undefined) updateData.name = updates.name;
  if (updates.url !== undefined) updateData.url = updates.url;
  if (updates.events !== undefined) updateData.events = updates.events;
  if (updates.isActive !== undefined) updateData.is_active = updates.isActive;

  const { data, error } = await supabase
    .from('developer_webhooks')
    .update(updateData)
    .eq('id', webhookId)
    .select()
    .single();

  if (error) throw error;

  return mapDeveloperWebhook(data);
}

// Delete Developer Webhook
export async function deleteDeveloperWebhook(webhookId: string): Promise<void> {
  const supabase = await createClient();

  const { error } = await supabase
    .from('developer_webhooks')
    .delete()
    .eq('id', webhookId);

  if (error) throw error;
}

// Rotate Webhook Secret
export async function rotateWebhookSecret(
  webhookId: string
): Promise<DeveloperWebhook> {
  const supabase = await createClient();
  const newSecret = generateWebhookSecret();

  const { data, error } = await supabase
    .from('developer_webhooks')
    .update({ secret: newSecret })
    .eq('id', webhookId)
    .select()
    .single();

  if (error) throw error;

  return mapDeveloperWebhook(data);
}

// Trigger Webhook
export async function triggerWebhook<T>(
  workspaceId: string,
  event: DeveloperWebhookEvent,
  data: T
): Promise<void> {
  const supabase = await createClient();

  // Get all active webhooks for this event
  const { data: webhooks } = await supabase
    .from('developer_webhooks')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('is_active', true)
    .contains('events', [event]);

  if (!webhooks?.length) return;

  // Create payload
  const payload: WebhookPayload<T> = {
    id: crypto.randomUUID(),
    event,
    apiVersion: '2025-01-01',
    timestamp: new Date().toISOString(),
    workspaceId,
    data,
  };

  // Queue deliveries
  for (const webhook of webhooks) {
    queueWebhookDelivery(webhook.id, payload).catch(console.error);
  }
}

// Queue Webhook Delivery
async function queueWebhookDelivery<T>(
  webhookId: string,
  payload: WebhookPayload<T>
): Promise<void> {
  const supabase = await createClient();

  // Store pending delivery
  await supabase.from('webhook_delivery_queue').insert({
    webhook_id: webhookId,
    payload_id: payload.id,
    payload: payload,
    attempts: 0,
    next_attempt_at: new Date().toISOString(),
    status: 'pending',
  });

  // Attempt immediate delivery
  await deliverWebhook(webhookId, payload, 0);
}

// Deliver Webhook
async function deliverWebhook<T>(
  webhookId: string,
  payload: WebhookPayload<T>,
  attempt: number
): Promise<boolean> {
  const supabase = await createClient();

  // Get webhook details
  const { data: webhook } = await supabase
    .from('developer_webhooks')
    .select('*')
    .eq('id', webhookId)
    .single();

  if (!webhook || !webhook.is_active) {
    return false;
  }

  const payloadString = JSON.stringify(payload);
  const signature = signWebhookPayload(payloadString, webhook.secret);
  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT);

    const response = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Webhook-Event': payload.event,
        'X-Webhook-Id': payload.id,
        'X-API-Version': payload.apiVersion,
        'User-Agent': 'ColdForge-Webhook/1.0',
      },
      body: payloadString,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    const duration = Date.now() - startTime;
    const responseBody = await response.text().catch(() => '');

    // Record delivery attempt
    await recordDeliveryAttempt(webhookId, payload.id, {
      attempt: attempt + 1,
      statusCode: response.status,
      responseBody: responseBody.slice(0, 1000), // Limit stored response
      duration,
    });

    // Check success (2xx status)
    if (response.ok) {
      // Update queue status to delivered
      await supabase
        .from('webhook_delivery_queue')
        .update({ status: 'delivered' })
        .eq('webhook_id', webhookId)
        .eq('payload_id', payload.id);

      return true;
    }

    // Failed but retriable
    return await scheduleRetry(webhookId, payload, attempt);
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Record failed attempt
    await recordDeliveryAttempt(webhookId, payload.id, {
      attempt: attempt + 1,
      error: errorMessage,
      duration,
    });

    // Schedule retry
    return await scheduleRetry(webhookId, payload, attempt);
  }
}

// Schedule Retry
async function scheduleRetry<T>(
  webhookId: string,
  payload: WebhookPayload<T>,
  currentAttempt: number
): Promise<boolean> {
  const supabase = await createClient();

  if (currentAttempt >= MAX_RETRY_ATTEMPTS - 1) {
    // Max retries reached
    await supabase
      .from('webhook_delivery_queue')
      .update({ status: 'failed' })
      .eq('webhook_id', webhookId)
      .eq('payload_id', payload.id);

    return false;
  }

  const nextAttempt = currentAttempt + 1;
  const delaySeconds = RETRY_DELAYS[nextAttempt] || RETRY_DELAYS[RETRY_DELAYS.length - 1];
  const nextAttemptAt = new Date(Date.now() + delaySeconds * 1000);

  await supabase
    .from('webhook_delivery_queue')
    .update({
      attempts: nextAttempt,
      next_attempt_at: nextAttemptAt.toISOString(),
      status: 'pending',
    })
    .eq('webhook_id', webhookId)
    .eq('payload_id', payload.id);

  return false;
}

// Record Delivery Attempt
async function recordDeliveryAttempt(
  webhookId: string,
  payloadId: string,
  attempt: {
    attempt: number;
    statusCode?: number;
    responseBody?: string;
    error?: string;
    duration: number;
  }
): Promise<void> {
  const supabase = await createClient();

  await supabase.from('webhook_delivery_attempts').insert({
    webhook_id: webhookId,
    payload_id: payloadId,
    attempt: attempt.attempt,
    status_code: attempt.statusCode,
    response_body: attempt.responseBody,
    error: attempt.error,
    duration: attempt.duration,
  });
}

// Get Webhook Deliveries
export async function getWebhookDeliveries(
  webhookId: string,
  options: {
    limit?: number;
    offset?: number;
    status?: 'pending' | 'delivered' | 'failed';
  } = {}
): Promise<{ deliveries: WebhookDeliveryAttempt[]; total: number }> {
  const supabase = await createClient();
  const { limit = 50, offset = 0, status } = options;

  const query = supabase
    .from('webhook_delivery_attempts')
    .select('*', { count: 'exact' })
    .eq('webhook_id', webhookId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  // Filter by delivery status from queue if needed
  // This is a simplified version - in production you'd join with queue

  const { data, error, count } = await query;

  if (error) throw error;

  return {
    deliveries: (data || []).map((d) => ({
      id: d.id,
      webhookId: d.webhook_id,
      payloadId: d.payload_id,
      attempt: d.attempt,
      statusCode: d.status_code,
      responseBody: d.response_body,
      error: d.error,
      duration: d.duration,
      createdAt: new Date(d.created_at),
    })),
    total: count || 0,
  };
}

// Retry Failed Deliveries (cron job)
export async function retryFailedDeliveries(): Promise<number> {
  const supabase = await createClient();

  const { data: pendingDeliveries } = await supabase
    .from('webhook_delivery_queue')
    .select('*')
    .eq('status', 'pending')
    .lte('next_attempt_at', new Date().toISOString())
    .limit(100);

  let retried = 0;

  for (const delivery of pendingDeliveries || []) {
    await deliverWebhook(
      delivery.webhook_id,
      delivery.payload,
      delivery.attempts
    );
    retried++;
  }

  return retried;
}

// Test Webhook
export async function testWebhook(webhookId: string): Promise<{
  success: boolean;
  statusCode?: number;
  error?: string;
  duration: number;
}> {
  const supabase = await createClient();

  const { data: webhook } = await supabase
    .from('developer_webhooks')
    .select('*')
    .eq('id', webhookId)
    .single();

  if (!webhook) {
    return { success: false, error: 'Webhook not found', duration: 0 };
  }

  const testPayload: WebhookPayload<{ test: boolean }> = {
    id: crypto.randomUUID(),
    event: 'campaign.created', // Use a common event
    apiVersion: '2025-01-01',
    timestamp: new Date().toISOString(),
    workspaceId: webhook.workspace_id,
    data: { test: true },
  };

  const payloadString = JSON.stringify(testPayload);
  const signature = signWebhookPayload(payloadString, webhook.secret);
  const startTime = Date.now();

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT);

    const response = await fetch(webhook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Webhook-Event': testPayload.event,
        'X-Webhook-Id': testPayload.id,
        'X-API-Version': testPayload.apiVersion,
        'User-Agent': 'ColdForge-Webhook/1.0',
      },
      body: payloadString,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const duration = Date.now() - startTime;

    return {
      success: response.ok,
      statusCode: response.status,
      duration,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      duration,
    };
  }
}

// Helper: Map database row to DeveloperWebhook
function mapDeveloperWebhook(data: Record<string, unknown>): DeveloperWebhook {
  return {
    id: data.id as string,
    workspaceId: data.workspace_id as string,
    name: data.name as string,
    url: data.url as string,
    secret: data.secret as string,
    events: data.events as DeveloperWebhookEvent[],
    isActive: data.is_active as boolean,
    version: data.version as string,
    createdAt: new Date(data.created_at as string),
    updatedAt: new Date(data.updated_at as string),
  };
}
