// Postmark Webhook Handler
// Processes bounce, spam complaint, delivery, open, and click notifications

import { NextRequest, NextResponse } from 'next/server';
import { processWebhook } from '@/lib/smtp/webhooks';
import { resolveWebhookPolicy, safeCompare } from '@/lib/webhooks/verification';

export async function POST(request: NextRequest) {
  try {
    // Postmark can use basic auth or a custom header for verification
    const authHeader = request.headers.get('authorization') || '';
    const webhookToken = request.headers.get('x-postmark-webhook-token') || '';

    // Fail closed: previously an unset POSTMARK_WEBHOOK_TOKEN skipped the check
    // entirely, leaving this endpoint unauthenticated in every environment
    // including production.
    const policy = resolveWebhookPolicy({
      provider: 'postmark',
      secret: process.env.POSTMARK_WEBHOOK_TOKEN,
    });

    if (policy.outcome === 'refuse') {
      console.error(policy.logMessage);
      return NextResponse.json({ error: policy.error }, { status: policy.status });
    }

    if (policy.outcome === 'skip') {
      console.warn(policy.logMessage);
    } else {
      const isValid =
        safeCompare(webhookToken, policy.secret) ||
        safeCompare(authHeader, `Bearer ${policy.secret}`);

      if (!isValid) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    }

    const body = await request.json();

    // Postmark sends individual events (not batched)
    const result = await processWebhook('postmark', body);

    if (result.errors.length > 0) {
      console.error('Postmark webhook errors:', result.errors);
    }

    return NextResponse.json({
      processed: result.processed,
      errors: result.errors.length,
    });
  } catch (error) {
    console.error('Postmark webhook error:', error);
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
    provider: 'postmark',
    description: 'Postmark webhook endpoint',
    supportedEvents: ['Bounce', 'SpamComplaint', 'Delivery', 'Open', 'Click'],
  });
}
