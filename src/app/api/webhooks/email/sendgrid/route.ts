// SendGrid Webhook Handler
// Processes event notifications from SendGrid

import { NextRequest, NextResponse } from 'next/server';
import { processWebhookBatch, verifyWebhookSignature } from '@/lib/smtp/webhooks';
import { resolveWebhookPolicy } from '@/lib/webhooks/verification';

export async function POST(request: NextRequest) {
  try {
    const body = await request.text();
    const signature = request.headers.get('x-twilio-email-event-webhook-signature') || '';
    const timestamp = request.headers.get('x-twilio-email-event-webhook-timestamp') || '';

    // Build full signature string for verification
    const fullSignature = timestamp ? `t=${timestamp},v1=${signature}` : signature;

    // Fail closed. Previously verification only ran in production, and outside
    // production a FAILED signature was logged and then processed anyway.
    const policy = resolveWebhookPolicy({
      provider: 'sendgrid',
      secret: process.env.SENDGRID_WEBHOOK_VERIFICATION_KEY,
    });

    if (policy.outcome === 'refuse') {
      console.error(policy.logMessage);
      return NextResponse.json({ error: policy.error }, { status: policy.status });
    }

    if (policy.outcome === 'skip') {
      console.warn(policy.logMessage);
    } else {
      if (!signature) {
        console.error('Missing SendGrid webhook signature');
        return NextResponse.json({ error: 'Missing signature' }, { status: 401 });
      }
      const isValid = verifyWebhookSignature('sendgrid', body, fullSignature, policy.secret);
      if (!isValid) {
        console.error('SendGrid webhook signature verification failed');
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
      }
    }

    // SendGrid sends events as an array
    const events = JSON.parse(body);

    if (!Array.isArray(events)) {
      return NextResponse.json({ error: 'Expected array of events' }, { status: 400 });
    }

    const result = await processWebhookBatch('sendgrid', events);

    if (result.errors.length > 0) {
      console.error('SendGrid webhook errors:', result.errors);
    }

    return NextResponse.json({
      processed: result.processed,
      total: events.length,
      errors: result.errors.length,
    });
  } catch (error) {
    console.error('SendGrid webhook error:', error);
    return NextResponse.json(
      { error: 'Failed to process webhook' },
      { status: 500 }
    );
  }
}

// Verification endpoint
export async function GET() {
  return NextResponse.json({
    status: 'active',
    provider: 'sendgrid',
    description: 'SendGrid event webhook endpoint',
    events: [
      'processed', 'dropped', 'delivered', 'deferred',
      'bounce', 'open', 'click', 'spamreport', 'unsubscribe'
    ],
  });
}
