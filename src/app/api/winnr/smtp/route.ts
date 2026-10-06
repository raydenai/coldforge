import { NextResponse, type NextRequest } from 'next/server'
import { assertSameOrigin, parseJsonRequest, resolveAuthContext, winnrErrorResponse } from '../_shared'
import { WinnrApiError } from '@/lib/winnr/server'
import { createServiceRoleRepository } from '@/lib/winnr/database'
import { createWinnrSmtpRepository } from '@/lib/winnr/smtp-database'
import { createWinnrSmtpSyncDeps, syncWinnrSmtpCredentials } from '@/lib/winnr/smtp'
export async function GET() {
  try {
    const actor = await resolveAuthContext()
    const connection = await createServiceRoleRepository().getConnection(actor.organizationId)
    if (!connection) return NextResponse.json({ mailboxes: [], connectionId: null })
    const mailboxes = await createWinnrSmtpRepository().status(actor.organizationId, connection.id, connection.version)
    return NextResponse.json({ mailboxes, connectionId: connection.id, connectionVersion: connection.version })
  } catch (error) { return winnrErrorResponse(error) }
}
export async function POST(request: NextRequest) {
  try {
    const actor = await resolveAuthContext()
    assertSameOrigin(request)
    if (!['owner', 'admin'].includes(actor.role)) throw new WinnrApiError(403, 'forbidden', 'Only owners and admins may import SMTP credentials')
    const result = await syncWinnrSmtpCredentials(actor, await parseJsonRequest(request), createWinnrSmtpSyncDeps())
    return NextResponse.json(result)
  } catch (error) { return winnrErrorResponse(error) }
}
