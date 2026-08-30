// Public API: Individual API Key Operations
import { NextRequest } from 'next/server';
import {
  withAPIMiddleware,
  createSuccessResponse,
  createErrorResponse,
  validateRequestBody,
  type APIContext,
} from '@/lib/api/middleware';
import {
  getAPIKey,
  updateAPIKey,
  revokeAPIKey,
  deleteAPIKey,
  regenerateAPIKey,
  getAPIKeyStats,
  type APIKeyPermission,
} from '@/lib/api/keys';

// Valid permissions
const VALID_PERMISSIONS: APIKeyPermission[] = [
  'campaigns:read',
  'campaigns:write',
  'leads:read',
  'leads:write',
  'mailboxes:read',
  'mailboxes:write',
  'analytics:read',
  'webhooks:read',
  'webhooks:write',
  'sequences:read',
  'sequences:write',
  'templates:read',
  'templates:write',
];

// GET /api/v1/api-keys/:id
export const GET = withAPIMiddleware(
  async (
    request: NextRequest,
    context: APIContext
  ) => {
    const keyId = request.nextUrl.pathname.split('/').pop();

    const key = await getAPIKey(keyId!);

    if (!key || key.workspaceId !== context.workspaceId) {
      return createErrorResponse(
        { code: 'not_found', message: 'API key not found' },
        404
      );
    }

    // Include stats if requested
    const includeStats = request.nextUrl.searchParams.get('include') === 'stats';

    const response: Record<string, unknown> = {
      id: key.id,
      name: key.name,
      keyPrefix: key.keyPrefix,
      permissions: key.permissions,
      status: key.status,
      rateLimit: key.rateLimit,
      lastUsedAt: key.lastUsedAt,
      lastUsedIp: key.lastUsedIp,
      expiresAt: key.expiresAt,
      createdAt: key.createdAt,
    };

    if (includeStats) {
      const stats = await getAPIKeyStats(keyId!);
      response.stats = stats;
    }

    return createSuccessResponse(response);
  },
  {
    allowApiKey: false,
    allowOAuth: true,
    requiredScope: 'read',
  }
);

// PUT /api/v1/api-keys/:id
export const PUT = withAPIMiddleware(
  async (
    request: NextRequest,
    context: APIContext
  ) => {
    const keyId = request.nextUrl.pathname.split('/').pop();

    // Verify ownership
    const key = await getAPIKey(keyId!);
    if (!key || key.workspaceId !== context.workspaceId) {
      return createErrorResponse(
        { code: 'not_found', message: 'API key not found' },
        404
      );
    }

    const { data: body, error: validationError } = await validateRequestBody<{
      name?: string;
      permissions?: APIKeyPermission[];
      rateLimit?: number;
    }>(request, (data) => {
      const d = data as Record<string, unknown>;

      if (d.permissions && Array.isArray(d.permissions)) {
        const invalidPerms = (d.permissions as string[]).filter(
          (p) => !VALID_PERMISSIONS.includes(p as APIKeyPermission)
        );
        if (invalidPerms.length > 0) {
          return {
            valid: false,
            errors: [`Invalid permissions: ${invalidPerms.join(', ')}`],
          };
        }
      }

      if (d.rateLimit !== undefined) {
        const rl = d.rateLimit as number;
        if (typeof rl !== 'number' || rl < 1 || rl > 1000) {
          return {
            valid: false,
            errors: ['rateLimit must be between 1 and 1000'],
          };
        }
      }

      return { valid: true, data: d };
    });

    if (validationError) return validationError;

    try {
      const updated = await updateAPIKey(keyId!, {
        name: body!.name,
        permissions: body!.permissions,
        rateLimit: body!.rateLimit,
      });

      return createSuccessResponse({
        id: updated.id,
        name: updated.name,
        keyPrefix: updated.keyPrefix,
        permissions: updated.permissions,
        status: updated.status,
        rateLimit: updated.rateLimit,
        lastUsedAt: updated.lastUsedAt,
        expiresAt: updated.expiresAt,
        createdAt: updated.createdAt,
      });
    } catch (error) {
      return createErrorResponse(
        {
          code: 'update_failed',
          message:
            error instanceof Error ? error.message : 'Failed to update API key',
        },
        500
      );
    }
  },
  {
    allowApiKey: false,
    allowOAuth: true,
    requiredScope: 'write',
  }
);

// DELETE /api/v1/api-keys/:id
export const DELETE = withAPIMiddleware(
  async (
    request: NextRequest,
    context: APIContext
  ) => {
    const keyId = request.nextUrl.pathname.split('/').pop();

    // Verify ownership
    const key = await getAPIKey(keyId!);
    if (!key || key.workspaceId !== context.workspaceId) {
      return createErrorResponse(
        { code: 'not_found', message: 'API key not found' },
        404
      );
    }

    try {
      await deleteAPIKey(keyId!);
      return createSuccessResponse({ deleted: true });
    } catch (error) {
      return createErrorResponse(
        {
          code: 'delete_failed',
          message:
            error instanceof Error ? error.message : 'Failed to delete API key',
        },
        500
      );
    }
  },
  {
    allowApiKey: false,
    allowOAuth: true,
    requiredScope: 'write',
  }
);

// POST /api/v1/api-keys/:id (for actions: revoke, regenerate)
export const POST = withAPIMiddleware(
  async (
    request: NextRequest,
    context: APIContext
  ) => {
    const pathParts = request.nextUrl.pathname.split('/');
    const keyId = pathParts[pathParts.indexOf('api-keys') + 1];

    // Verify ownership
    const key = await getAPIKey(keyId!);
    if (!key || key.workspaceId !== context.workspaceId) {
      return createErrorResponse(
        { code: 'not_found', message: 'API key not found' },
        404
      );
    }

    const { data: body, error: validationError } = await validateRequestBody<{
      action: 'revoke' | 'regenerate';
    }>(request, (data) => {
      const d = data as Record<string, unknown>;
      if (!d.action || !['revoke', 'regenerate'].includes(d.action as string)) {
        return {
          valid: false,
          errors: ['action must be either "revoke" or "regenerate"'],
        };
      }
      return { valid: true, data: d };
    });

    if (validationError) return validationError;

    try {
      if (body!.action === 'revoke') {
        await revokeAPIKey(keyId!);
        return createSuccessResponse({
          id: keyId,
          status: 'revoked',
          message: 'API key has been revoked and can no longer be used.',
        });
      }

      if (body!.action === 'regenerate') {
        const newKey = await regenerateAPIKey(keyId!, context.userId!);
        return createSuccessResponse({
          id: newKey.id,
          name: newKey.name,
          keyPrefix: newKey.keyPrefix,
          secretKey: newKey.secretKey, // New secret key
          permissions: newKey.permissions,
          status: newKey.status,
          rateLimit: newKey.rateLimit,
          createdAt: newKey.createdAt,
          message:
            'New API key generated. The old key has been revoked. Store the new secretKey securely.',
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
  {
    allowApiKey: false,
    allowOAuth: true,
    requiredScope: 'write',
  }
);
