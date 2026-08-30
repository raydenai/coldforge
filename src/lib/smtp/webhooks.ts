// SMTP Webhook Handlers
// Process bounce, complaint, and delivery notifications from email providers

import crypto from 'node:crypto';
import { createClient } from '../supabase/server';
import { isAwsSnsHostname } from '../webhooks/verification';
import type { EventType, BounceType, EmailEvent } from './types';

// Webhook payload types for different providers
interface SesNotification {
  notificationType: 'Bounce' | 'Complaint' | 'Delivery';
  bounce?: {
    bounceType: 'Permanent' | 'Transient';
    bounceSubType: string;
    bouncedRecipients: Array<{
      emailAddress: string;
      action?: string;
      status?: string;
      diagnosticCode?: string;
    }>;
    timestamp: string;
  };
  complaint?: {
    complainedRecipients: Array<{ emailAddress: string }>;
    complaintFeedbackType?: string;
    timestamp: string;
  };
  delivery?: {
    recipients: string[];
    timestamp: string;
    processingTimeMillis?: number;
    smtpResponse?: string;
  };
  mail: {
    messageId: string;
    source: string;
    destination: string[];
    timestamp: string;
    headers?: Array<{ name: string; value: string }>;
  };
}

interface SendGridEvent {
  event: 'processed' | 'dropped' | 'delivered' | 'deferred' | 'bounce' | 'open' | 'click' | 'spamreport' | 'unsubscribe' | 'group_unsubscribe' | 'group_resubscribe';
  email: string;
  timestamp: number;
  'smtp-id'?: string;
  sg_message_id?: string;
  category?: string[];
  reason?: string;
  status?: string;
  type?: string;
  url?: string;
  ip?: string;
  useragent?: string;
}

interface PostmarkWebhook {
  RecordType: 'Bounce' | 'SpamComplaint' | 'Delivery' | 'Open' | 'Click';
  MessageID: string;
  Email: string;
  BouncedAt?: string;
  Type?: string;
  TypeCode?: number;
  Description?: string;
  Details?: string;
  DeliveredAt?: string;
  ReceivedAt?: string;
  OriginalLink?: string;
  UserAgent?: string;
  Geo?: { CountryISOCode?: string; Region?: string; City?: string };
}

// Normalize provider webhooks to common format
export interface NormalizedWebhookEvent {
  eventType: EventType;
  messageId?: string;
  recipientEmail: string;
  timestamp: Date;
  bounceType?: BounceType;
  bounceSubtype?: string;
  clickedUrl?: string;
  userAgent?: string;
  ipAddress?: string;
  geoCountry?: string;
  geoCity?: string;
  rawData?: Record<string, unknown>;
}

// Parse AWS SES notification
function parseSesNotification(payload: SesNotification): NormalizedWebhookEvent[] {
  const events: NormalizedWebhookEvent[] = [];
  const messageId = payload.mail.messageId;

  if (payload.notificationType === 'Bounce' && payload.bounce) {
    const bounceType: BounceType = payload.bounce.bounceType === 'Permanent' ? 'hard' : 'soft';

    for (const recipient of payload.bounce.bouncedRecipients) {
      events.push({
        eventType: 'bounced',
        messageId,
        recipientEmail: recipient.emailAddress,
        timestamp: new Date(payload.bounce.timestamp),
        bounceType,
        bounceSubtype: payload.bounce.bounceSubType,
        rawData: { diagnosticCode: recipient.diagnosticCode },
      });
    }
  } else if (payload.notificationType === 'Complaint' && payload.complaint) {
    for (const recipient of payload.complaint.complainedRecipients) {
      events.push({
        eventType: 'complained',
        messageId,
        recipientEmail: recipient.emailAddress,
        timestamp: new Date(payload.complaint.timestamp),
        rawData: { feedbackType: payload.complaint.complaintFeedbackType },
      });
    }
  } else if (payload.notificationType === 'Delivery' && payload.delivery) {
    for (const recipient of payload.delivery.recipients) {
      events.push({
        eventType: 'delivered',
        messageId,
        recipientEmail: recipient,
        timestamp: new Date(payload.delivery.timestamp),
        rawData: {
          processingTime: payload.delivery.processingTimeMillis,
          smtpResponse: payload.delivery.smtpResponse,
        },
      });
    }
  }

  return events;
}

// Parse SendGrid event
function parseSendGridEvent(event: SendGridEvent): NormalizedWebhookEvent | null {
  const eventMap: Record<string, EventType | null> = {
    delivered: 'delivered',
    bounce: 'bounced',
    dropped: 'bounced',
    spamreport: 'complained',
    unsubscribe: 'unsubscribed',
    open: 'opened',
    click: 'clicked',
    deferred: 'deferred',
    processed: null,
    group_unsubscribe: 'unsubscribed',
    group_resubscribe: null,
  };

  const eventType = eventMap[event.event];
  if (!eventType) return null;

  let bounceType: BounceType | undefined;
  if (event.event === 'bounce') {
    bounceType = event.type === 'blocked' ? 'soft' : 'hard';
  } else if (event.event === 'dropped') {
    bounceType = 'hard';
  }

  return {
    eventType,
    messageId: event.sg_message_id || event['smtp-id'],
    recipientEmail: event.email,
    timestamp: new Date(event.timestamp * 1000),
    bounceType,
    bounceSubtype: event.reason,
    clickedUrl: event.url,
    userAgent: event.useragent,
    ipAddress: event.ip,
    rawData: { status: event.status, category: event.category },
  };
}

// Parse Postmark webhook
function parsePostmarkWebhook(payload: PostmarkWebhook): NormalizedWebhookEvent | null {
  const eventMap: Record<string, EventType> = {
    Bounce: 'bounced',
    SpamComplaint: 'complained',
    Delivery: 'delivered',
    Open: 'opened',
    Click: 'clicked',
  };

  const eventType = eventMap[payload.RecordType];
  if (!eventType) return null;

  let bounceType: BounceType | undefined;
  if (payload.RecordType === 'Bounce') {
    // Postmark TypeCode: 1 = HardBounce, 2 = Transient, etc.
    bounceType = payload.TypeCode === 1 ? 'hard' : 'soft';
  }

  const timestamp = payload.BouncedAt || payload.DeliveredAt || payload.ReceivedAt;

  return {
    eventType,
    messageId: payload.MessageID,
    recipientEmail: payload.Email,
    timestamp: new Date(timestamp || Date.now()),
    bounceType,
    bounceSubtype: payload.Type,
    clickedUrl: payload.OriginalLink,
    userAgent: payload.UserAgent,
    geoCountry: payload.Geo?.CountryISOCode,
    geoCity: payload.Geo?.City,
    rawData: { description: payload.Description, details: payload.Details },
  };
}

// Process webhook from any provider
export async function processWebhook(
  provider: 'ses' | 'sendgrid' | 'postmark',
  payload: unknown
): Promise<{ processed: number; errors: string[] }> {
  const errors: string[] = [];
  let events: NormalizedWebhookEvent[] = [];

  try {
    switch (provider) {
      case 'ses':
        events = parseSesNotification(payload as SesNotification);
        break;
      case 'sendgrid':
        const sgEvent = parseSendGridEvent(payload as SendGridEvent);
        if (sgEvent) events = [sgEvent];
        break;
      case 'postmark':
        const pmEvent = parsePostmarkWebhook(payload as PostmarkWebhook);
        if (pmEvent) events = [pmEvent];
        break;
    }
  } catch (error) {
    errors.push(`Parse error: ${error instanceof Error ? error.message : 'Unknown'}`);
    return { processed: 0, errors };
  }

  // Process each event
  for (const event of events) {
    try {
      await processEmailEvent(event);
    } catch (error) {
      errors.push(`Event processing error: ${error instanceof Error ? error.message : 'Unknown'}`);
    }
  }

  return { processed: events.length - errors.length, errors };
}

// Process batch of SendGrid events (they send arrays)
export async function processWebhookBatch(
  provider: 'sendgrid',
  events: unknown[]
): Promise<{ processed: number; errors: string[] }> {
  const errors: string[] = [];
  let processed = 0;

  for (const event of events) {
    const result = await processWebhook(provider, event);
    processed += result.processed;
    errors.push(...result.errors);
  }

  return { processed, errors };
}

// Process a normalized email event
async function processEmailEvent(event: NormalizedWebhookEvent): Promise<void> {
  const supabase = await createClient();

  // Find the email in queue by message_id
  let queuedEmail: { id: string; workspace_id: string; campaign_id?: string; lead_id?: string; tracking_id?: string } | null = null;

  if (event.messageId) {
    const { data } = await supabase
      .from('email_queue')
      .select('id, workspace_id, campaign_id, lead_id, tracking_id')
      .eq('message_id', event.messageId)
      .single();
    queuedEmail = data;
  }

  // Record the event
  await supabase.from('email_events').insert({
    workspace_id: queuedEmail?.workspace_id,
    email_queue_id: queuedEmail?.id,
    campaign_id: queuedEmail?.campaign_id,
    message_id: event.messageId,
    tracking_id: queuedEmail?.tracking_id,
    event_type: event.eventType,
    recipient_email: event.recipientEmail,
    lead_id: queuedEmail?.lead_id,
    event_data: event.rawData,
    clicked_url: event.clickedUrl,
    bounce_type: event.bounceType,
    bounce_subtype: event.bounceSubtype,
    user_agent: event.userAgent,
    ip_address: event.ipAddress,
    geo_country: event.geoCountry,
    geo_city: event.geoCity,
    occurred_at: event.timestamp.toISOString(),
  });

  // Update queue status if applicable
  if (queuedEmail && ['delivered', 'bounced'].includes(event.eventType)) {
    const updates: Record<string, unknown> = {
      status: event.eventType === 'delivered' ? 'delivered' : 'bounced',
    };

    if (event.eventType === 'delivered') {
      updates.delivered_at = event.timestamp.toISOString();
    } else {
      updates.error_code = event.bounceType;
      updates.error_message = event.bounceSubtype;
    }

    await supabase
      .from('email_queue')
      .update(updates)
      .eq('id', queuedEmail.id);
  }

  // Handle suppression for bounces and complaints
  if (['bounced', 'complained'].includes(event.eventType)) {
    await handleSuppression(event, queuedEmail?.workspace_id);
  }
}

// Handle email suppression
async function handleSuppression(
  event: NormalizedWebhookEvent,
  workspaceId?: string
): Promise<void> {
  const supabase = await createClient();

  // Determine suppression reason
  let reason: string;
  if (event.eventType === 'complained') {
    reason = 'complaint';
  } else if (event.bounceType === 'hard') {
    reason = 'hard_bounce';
  } else {
    reason = 'soft_bounce';
  }

  // Only auto-suppress for hard bounces and complaints
  if (reason !== 'soft_bounce') {
    // Check if already suppressed
    const { data: existing } = await supabase
      .from('email_suppressions')
      .select('id')
      .eq('email', event.recipientEmail.toLowerCase())
      .eq('is_active', true)
      .limit(1)
      .single();

    if (!existing) {
      await supabase.from('email_suppressions').insert({
        workspace_id: workspaceId, // null for global suppression
        email: event.recipientEmail.toLowerCase(),
        reason,
        source: 'webhook',
        notes: `Auto-suppressed from ${event.eventType} event`,
        is_active: true,
      });
    }
  }

  // For soft bounces, increment counter (handled by RLS trigger)
  // After 3 soft bounces, could convert to hard suppression
}

// Verify webhook signature (provider-specific)
export function verifyWebhookSignature(
  provider: 'ses' | 'sendgrid' | 'postmark',
  payload: string,
  signature: string,
  secret: string
): boolean {
  switch (provider) {
    case 'ses':
      // SES/SNS authenticates by certificate-backed signature over the whole
      // message, which this signature-and-secret shape cannot express. Use
      // verifySnsMessage() instead.
      //
      // This previously returned `true`, so any caller passing 'ses' was
      // silently granted a pass by a function named "verify".
      throw new Error(
        'verifyWebhookSignature does not support SES. Use verifySnsMessage() for SNS-delivered SES notifications.'
      );

    case 'sendgrid':
      // SendGrid uses ECDSA signatures with the public key
      // The signature header is base64-encoded
      // Verify by creating HMAC-SHA256 of timestamp + payload
      try {
        const timestampHeader = signature.split(',')[0]; // t=timestamp
        const signatureHeader = signature.split(',')[1]; // v1=signature

        if (!timestampHeader || !signatureHeader) {
          // Fallback for older format - simple HMAC
          const expectedSig = crypto
            .createHmac('sha256', secret)
            .update(payload)
            .digest('hex');
          return crypto.timingSafeEqual(
            Buffer.from(signature),
            Buffer.from(expectedSig)
          );
        }

        const timestamp = timestampHeader.replace('t=', '');
        const providedSig = signatureHeader.replace('v1=', '');

        // Verify timestamp is within 5 minutes
        const timestampAge = Math.abs(Date.now() / 1000 - parseInt(timestamp, 10));
        if (timestampAge > 300) {
          console.warn('SendGrid webhook timestamp too old');
          return false;
        }

        // Create expected signature
        const signedPayload = `${timestamp}${payload}`;
        const expectedSig = crypto
          .createHmac('sha256', secret)
          .update(signedPayload)
          .digest('base64');

        return crypto.timingSafeEqual(
          Buffer.from(providedSig),
          Buffer.from(expectedSig)
        );
      } catch {
        return false;
      }

    case 'postmark':
      // Postmark uses simple token matching
      return signature === secret;

    default:
      return false;
  }
}

// AWS SNS Message Signature Verification
export interface SnsMessage {
  Type: 'SubscriptionConfirmation' | 'Notification' | 'UnsubscribeConfirmation';
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  SubscribeURL?: string;
  Token?: string;
  Subject?: string;
}

// Cache for SNS signing certificates
const certCache = new Map<string, string>();

// Verify AWS SNS message signature
export async function verifySnsMessage(message: SnsMessage): Promise<boolean> {
  try {
    // Validate SigningCertURL is a genuine SNS endpoint.
    // A bare '.amazonaws.com' suffix check also matches attacker-controlled
    // hosts such as an S3 bucket, which would let a forged message supply its
    // own signing certificate and pass verification.
    let certUrl: URL;
    try {
      certUrl = new URL(message.SigningCertURL);
    } catch {
      console.error('Malformed SNS certificate URL');
      return false;
    }

    if (!isAwsSnsHostname(certUrl.hostname)) {
      console.error('Invalid SNS certificate URL host:', certUrl.hostname);
      return false;
    }

    // Only allow HTTPS
    if (certUrl.protocol !== 'https:') {
      console.error('SNS certificate URL must be HTTPS');
      return false;
    }

    // Get certificate (cached)
    let cert = certCache.get(message.SigningCertURL);
    if (!cert) {
      const certResponse = await fetch(message.SigningCertURL);
      if (!certResponse.ok) {
        console.error('Failed to fetch SNS certificate');
        return false;
      }
      cert = await certResponse.text();
      certCache.set(message.SigningCertURL, cert);
    }

    // Build string to sign based on message type
    let stringToSign: string;

    if (message.Type === 'Notification') {
      stringToSign = [
        'Message', message.Message,
        'MessageId', message.MessageId,
        ...(message.Subject ? ['Subject', message.Subject] : []),
        'Timestamp', message.Timestamp,
        'TopicArn', message.TopicArn,
        'Type', message.Type,
      ].join('\n') + '\n';
    } else {
      // SubscriptionConfirmation or UnsubscribeConfirmation
      stringToSign = [
        'Message', message.Message,
        'MessageId', message.MessageId,
        'SubscribeURL', message.SubscribeURL || '',
        'Timestamp', message.Timestamp,
        'Token', message.Token || '',
        'TopicArn', message.TopicArn,
        'Type', message.Type,
      ].join('\n') + '\n';
    }

    // Verify signature
    const verifier = crypto.createVerify('RSA-SHA1');
    verifier.update(stringToSign);

    const signatureBuffer = Buffer.from(message.Signature, 'base64');
    return verifier.verify(cert, signatureBuffer);
  } catch (error) {
    console.error('SNS signature verification error:', error);
    return false;
  }
}

// Get webhook endpoint URLs for provider configuration
export function getWebhookEndpoints(baseUrl: string): {
  ses: string;
  sendgrid: string;
  postmark: string;
} {
  return {
    ses: `${baseUrl}/api/webhooks/email/ses`,
    sendgrid: `${baseUrl}/api/webhooks/email/sendgrid`,
    postmark: `${baseUrl}/api/webhooks/email/postmark`,
  };
}
