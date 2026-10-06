import { randomUUID } from 'node:crypto'
import { createOutreachEventRepository } from '@/lib/outreach/event-database'
import { createOutreachEventService } from '@/lib/outreach/events'

export interface AuditEvent {
  user_id: string
  organization_id?: string
  action: AuditAction
  resource_type: ResourceType
  resource_id?: string
  details?: Record<string, unknown>
  ip_address?: string
  user_agent?: string
}

export type AuditAction =
  | 'create' | 'read' | 'update' | 'delete'
  | 'login' | 'logout' | 'password_change' | 'email_change'
  | 'api_key_create' | 'api_key_revoke'
  | 'invite_user' | 'remove_user' | 'role_change'
  | 'settings_change' | 'billing_change'
  | 'campaign_start' | 'campaign_pause' | 'campaign_delete'
  | 'export_data' | 'import_data'

export type ResourceType =
  | 'user' | 'organization' | 'campaign' | 'lead'
  | 'email_account' | 'domain' | 'mailbox'
  | 'api_key' | 'webhook' | 'settings'

export async function logAuditEvent(event: AuditEvent): Promise<void> {
  // Tenant-free auth events do not belong in an organization event stream.
  if (!event.organization_id) return
  const service = createOutreachEventService({ repository: createOutreachEventRepository() })
  await service.append({ event: {
    version: 1,
    organizationId: event.organization_id,
    type: `audit.${event.resource_type}.${event.action}`,
    source: 'coldforge',
    sourceEventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    correlationId: null,
    causationId: null,
    subject: {},
    // Deliberately omit arbitrary details, network addresses and request bodies.
    data: { actorUserId: event.user_id, resourceType: event.resource_type, resourceId: event.resource_id ?? null },
  }, consumers: [] })
}

// Helper for common patterns
export function createAuditLogger(userId: string, organizationId?: string) {
  return {
    log: (
      action: AuditAction,
      resourceType: ResourceType,
      resourceId?: string,
      details?: Record<string, unknown>
    ) => logAuditEvent({
      user_id: userId,
      organization_id: organizationId,
      action,
      resource_type: resourceType,
      resource_id: resourceId,
      details
    })
  }
}

// Async version that doesn't block
export function logAuditEventAsync(event: AuditEvent): void {
  // Fire and forget - don't await
  logAuditEvent(event).catch(err => {
    console.error('[AUDIT ASYNC ERROR]', err)
  })
}

// Helper to extract request metadata
export function getRequestMetadata(request: Request): { ip_address?: string; user_agent?: string } {
  const forwardedFor = request.headers.get('x-forwarded-for')
  const userAgent = request.headers.get('user-agent')

  return {
    ip_address: forwardedFor?.split(',')[0]?.trim() || undefined,
    user_agent: userAgent || undefined
  }
}
