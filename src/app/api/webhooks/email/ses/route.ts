// AWS SES Webhook Handler
// Processes bounce, complaint, and delivery notifications from SES via SNS

import { NextRequest, NextResponse } from 'next/server';
import { processWebhook, verifySnsMessage, type SnsMessage } from '@/lib/smtp/webhooks';
import { isAwsSnsHostname, isUnverifiedWebhookOptIn } from '@/lib/webhooks/verification';

export async function POST(request: NextRequest) {
  try {
    const body = await request.text();
    const snsMessage: SnsMessage = JSON.parse(body);

    // Fail closed: verification now runs in every environment. Previously it
    // was skipped outside production, which left the SubscribeURL fetch below
    // reachable by unauthenticated callers.
    if (isUnverifiedWebhookOptIn()) {
      console.warn(
        '[webhook:ses] accepting UNVERIFIED request: ALLOW_UNVERIFIED_WEBHOOKS=true. Never use this in production.'
      );
    } else {
      const isValid = await verifySnsMessage(snsMessage);
      if (!isValid) {
        console.error('SNS signature verification failed for message:', snsMessage.MessageId);
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
      }
    }

    // Handle SNS subscription confirmation
    if (snsMessage.Type === 'SubscriptionConfirmation') {
      // Verify the SubscribeURL is a genuine SNS endpoint before fetching it.
      // A bare '.amazonaws.com' suffix check also matches attacker-controlled
      // hosts such as an S3 bucket, making this fetch an SSRF vector.
      if (snsMessage.SubscribeURL) {
        let subscribeUrl: URL;
        try {
          subscribeUrl = new URL(snsMessage.SubscribeURL);
        } catch {
          console.error('Malformed SNS SubscribeURL');
          return NextResponse.json({ error: 'Invalid SubscribeURL' }, { status: 400 });
        }

        if (subscribeUrl.protocol !== 'https:' || !isAwsSnsHostname(subscribeUrl.hostname)) {
          console.error('Invalid SNS SubscribeURL host:', subscribeUrl.hostname);
          return NextResponse.json({ error: 'Invalid SubscribeURL' }, { status: 400 });
        }

        await fetch(snsMessage.SubscribeURL);
        console.log('SNS subscription confirmed:', snsMessage.TopicArn);
        return NextResponse.json({ confirmed: true });
      }
      return NextResponse.json({ error: 'No SubscribeURL' }, { status: 400 });
    }

    // Handle notification
    if (snsMessage.Type === 'Notification') {
      // Parse the actual SES notification from the SNS message
      const sesNotification = JSON.parse(snsMessage.Message);

      const result = await processWebhook('ses', sesNotification);

      if (result.errors.length > 0) {
        console.error('SES webhook errors:', result.errors);
      }

      return NextResponse.json({
        processed: result.processed,
        errors: result.errors.length,
      });
    }

    // Handle unsubscribe confirmation
    if (snsMessage.Type === 'UnsubscribeConfirmation') {
      console.log('SNS topic unsubscribed:', snsMessage.TopicArn);
      return NextResponse.json({ unsubscribed: true });
    }

    return NextResponse.json({ error: 'Unknown message type' }, { status: 400 });
  } catch (error) {
    console.error('SES webhook error:', error);
    return NextResponse.json(
      { error: 'Failed to process webhook' },
      { status: 500 }
    );
  }
}

// Verification endpoint for AWS SNS
export async function GET() {
  return NextResponse.json({
    status: 'active',
    provider: 'aws_ses',
    description: 'AWS SES webhook endpoint for bounce/complaint/delivery notifications',
  });
}
