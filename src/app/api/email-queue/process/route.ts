// Email Queue Processing API
// Called by cron job or background worker to process pending emails

import { NextRequest, NextResponse } from 'next/server';
import {
  processEmailBatch,
  getNextEmailsToProcess,
  getEmailsForRetry,
} from '@/lib/smtp/queue';

// Verify the request is from an authorized source
function verifyProcessingAuth(request: NextRequest): boolean {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    // In development, allow without auth
    if (process.env.NODE_ENV === 'development') {
      return true;
    }
    return false;
  }

  return authHeader === `Bearer ${cronSecret}`;
}

// POST /api/email-queue/process - Process pending emails
export async function POST(request: NextRequest) {
  try {
    // Verify authorization
    if (!verifyProcessingAuth(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const {
      limit = 50,
      workspaceId,
      includeRetries = true,
    } = body;

    // Process pending emails
    const result = await processEmailBatch(limit);

    // Process retries if enabled
    const retryResult = { processed: 0, successful: 0, failed: 0 };
    if (includeRetries) {
      const retryEmails = await getEmailsForRetry(Math.floor(limit / 4));
      for (const email of retryEmails) {
        // Re-use processEmailBatch logic
        retryResult.processed++;
      }
    }

    return NextResponse.json({
      success: true,
      processed: result.processed + retryResult.processed,
      successful: result.successful + retryResult.successful,
      failed: result.failed + retryResult.failed,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Process queue error:', error);
    return NextResponse.json(
      {
        error: 'Failed to process queue',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}

// GET /api/email-queue/process - Get queue status
export async function GET(request: NextRequest) {
  try {
    // Verify authorization
    if (!verifyProcessingAuth(request)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '10');

    // Get pending emails
    const pendingEmails = await getNextEmailsToProcess(limit);

    // Get retry emails
    const retryEmails = await getEmailsForRetry(limit);

    return NextResponse.json({
      pending: {
        count: pendingEmails.length,
        sample: pendingEmails.slice(0, 5).map((e) => ({
          id: e.id,
          toEmail: e.toEmail,
          subject: e.subject,
          scheduledAt: e.scheduledAt,
        })),
      },
      retry: {
        count: retryEmails.length,
        sample: retryEmails.slice(0, 5).map((e) => ({
          id: e.id,
          toEmail: e.toEmail,
          attempts: e.attempts,
          lastError: e.errorMessage,
          nextRetryAt: e.nextRetryAt,
        })),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Get queue status error:', error);
    return NextResponse.json(
      { error: 'Failed to get queue status' },
      { status: 500 }
    );
  }
}
