// Public API: Individual Webhook Operations
import { NextRequest } from 'next/server';
import {
  withAPIMiddleware,
  createSuccessResponse,
  createErrorResponse,
  validateRequestBody,
  type APIContext,
} from '@/lib/api/middleware';
import {
  getDeveloperWebhook,
  updateDeveloperWebhook,
  deleteDeveloperWebhook,
  rotateWebhookSecret,
  testWebhook,
  getWebhookDeliveries,
  type DeveloperWebhookEvent,
} from '@/lib/api/developer-webhooks';

// Valid webhook events
const VALID_EVENTS: DeveloperWebhookEvent[] = [
  'campaign.created',
  'campaign.updated',
  'campaign.started',
  'campaign.paused',
  'campaign.completed',
  'campaign.deleted',
  'lead.created',
  'lead.updated',
  'lead.deleted',
  'lead.status_changed',
  'email.sent',
  'email.delivered',
  'email.opened',
  'email.clicked',
  'email.replied',
  'email.bounced',
  'email.unsubscribed',
  'mailbox.connected',
  'mailbox.disconnected',
  'mailbox.health_changed',
  'sequence.completed',
  'sequence.stopped',
];

// GET /api/v1/webhooks/:id
export const GET = withAPIMiddleware(
  async (
    request: NextRequest,
    context: APIContext
  ) => {
    const webhookId = request.nextUrl.pathname.split('/').pop();

    const webhook = await getDeveloperWebhook(webhookId!);

    if (!webhook || webhook.workspaceId !== context.workspaceId) {
      return createErrorResponse(
        { code: 'not_found', message: 'Webhook not found' },
        404
      );
    }

    // Include deliveries if requested
    const includeDeliveries = request.nextUrl.searchParams.get('include') === 'deliveries';

    const response: Record<string, unknown> = {
      id: webhook.id,
      name: webhook.name,
      url: webhook.url,
      events: webhook.events,
      isActive: webhook.isActive,
      version: webhook.version,
      createdAt: webhook.createdAt,
      updatedAt: webhook.updatedAt,
    };

    if (includeDeliveries) {
      const { deliveries } = await getWebhookDeliveries(webhookId!, { limit: 10 });
      response.recentDeliveries = deliveries;
    }

    return createSuccessResponse(response);
  },
  { requiredPermission: 'webhooks:read' }
);

// PUT /api/v1/webhooks/:id
export const PUT = withAPIMiddleware(
  async (
    request: NextRequest,
    context: APIContext
  ) => {
    const webhookId = request.nextUrl.pathname.split('/').pop();

    // Verify ownership
    const webhook = await getDeveloperWebhook(webhookId!);
    if (!webhook || webhook.workspaceId !== context.workspaceId) {
      return createErrorResponse(
        { code: 'not_found', message: 'Webhook not found' },
        404
      );
    }

    const { data: body, error: validationError } = await validateRequestBody<{
      name?: string;
      url?: string;
      events?: DeveloperWebhookEvent[];
      isActive?: boolean;
    }>(request, (data) => {
      const d = data as Record<string, unknown>;

      if (d.url && typeof d.url === 'string') {
        try {
          const url = new URL(d.url);
          if (!['http:', 'https:'].includes(url.protocol)) {
            return { valid: false, errors: ['url must be http or https'] };
          }
        } catch {
          return { valid: false, errors: ['url is invalid'] };
        }
      }

      if (d.events && Array.isArray(d.events)) {
        const invalidEvents = (d.events as string[]).filter(
          (e) => !VALID_EVENTS.includes(e as DeveloperWebhookEvent)
        );
        if (invalidEvents.length > 0) {
          return {
            valid: false,
            errors: [`Invalid events: ${invalidEvents.join(', ')}`],
          };
        }
      }

      return { valid: true, data: d };
    });

    if (validationError) return validationError;

    try {
      const updated = await updateDeveloperWebhook(webhookId!, {
        name: body!.name,
        url: body!.url,
        events: body!.events,
        isActive: body!.isActive,
      });

      return createSuccessResponse({
        id: updated.id,
        name: updated.name,
        url: updated.url,
        events: updated.events,
        isActive: updated.isActive,
        version: updated.version,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
      });
    } catch (error) {
      return createErrorResponse(
        {
          code: 'update_failed',
          message: error instanceof Error ? error.message : 'Failed to update webhook',
        },
        500
      );
    }
  },
  { requiredPermission: 'webhooks:write' }
);

// DELETE /api/v1/webhooks/:id
export const DELETE = withAPIMiddleware(
  async (
    request: NextRequest,
    context: APIContext
  ) => {
    const webhookId = request.nextUrl.pathname.split('/').pop();

    // Verify ownership
    const webhook = await getDeveloperWebhook(webhookId!);
    if (!webhook || webhook.workspaceId !== context.workspaceId) {
      return createErrorResponse(
        { code: 'not_found', message: 'Webhook not found' },
        404
      );
    }

    try {
      await deleteDeveloperWebhook(webhookId!);
      return createSuccessResponse({ deleted: true });
    } catch (error) {
      return createErrorResponse(
        {
          code: 'delete_failed',
          message: error instanceof Error ? error.message : 'Failed to delete webhook',
        },
        500
      );
    }
  },
  { requiredPermission: 'webhooks:write' }
);

// POST /api/v1/webhooks/:id (for actions: test, rotate-secret)
export const POST = withAPIMiddleware(
  async (
    request: NextRequest,
    context: APIContext
  ) => {
    const pathParts = request.nextUrl.pathname.split('/');
    const webhookId = pathParts[pathParts.indexOf('webhooks') + 1];

    // Verify ownership
    const webhook = await getDeveloperWebhook(webhookId!);
    if (!webhook || webhook.workspaceId !== context.workspaceId) {
      return createErrorResponse(
        { code: 'not_found', message: 'Webhook not found' },
        404
      );
    }

    const { data: body, error: validationError } = await validateRequestBody<{
      action: 'test' | 'rotate-secret';
    }>(request, (data) => {
      const d = data as Record<string, unknown>;
      if (!d.action || !['test', 'rotate-secret'].includes(d.action as string)) {
        return {
          valid: false,
          errors: ['action must be either "test" or "rotate-secret"'],
        };
      }
      return { valid: true, data: d };
    });

    if (validationError) return validationError;

    try {
      if (body!.action === 'test') {
        const result = await testWebhook(webhookId!);
        return createSuccessResponse({
          success: result.success,
          statusCode: result.statusCode,
          error: result.error,
          duration: result.duration,
        });
      }

      if (body!.action === 'rotate-secret') {
        const updated = await rotateWebhookSecret(webhookId!);
        return createSuccessResponse({
          id: updated.id,
          secret: updated.secret, // New secret
          message: 'Secret rotated successfully. Update your webhook handler with the new secret.',
        });
      }

      return createErrorResponse(
        { code: 'invalid_action', message: 'Unknown action' },
        400
      );
    } catch (error) {
      return createErrorResponse(
        {
          code: 'action_failed',
          message: error instanceof Error ? error.message : 'Action failed',
        },
        500
      );
    }
  },
  { requiredPermission: 'webhooks:write' }
);
