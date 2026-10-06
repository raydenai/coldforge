import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { assertSameOrigin, resolveAuthContext, winnrErrorResponse, parseJsonRequest, buildWinnrDeps } from '@/app/api/winnr/_shared'
import { listMailboxes, WinnrApiError, type WinnrAuthContext } from '@/lib/winnr/server'
import { createCampaignRepository, type CampaignCoreRepository } from '@/lib/campaigns/repository'
export { parseJsonRequest }
export const idSchema = z.string().uuid()
export type RouteParams = { params: Promise<{ id: string }> }
export const paging = z.object({ page: z.coerce.number().int().min(1).max(100000).default(1), limit: z.coerce.number().int().min(1).max(100).default(25) })
export async function campaignRoute(request: NextRequest, write: boolean, run: (repo: CampaignCoreRepository, actor: WinnrAuthContext) => Promise<unknown>) {
  try {
    const actor = await resolveAuthContext()
    if (write) {
      assertSameOrigin(request)
      if (!['owner', 'admin'].includes(actor.role)) throw new WinnrApiError(403, 'forbidden', 'Only organization owners and admins may change campaigns')
    }
    return NextResponse.json(await run(createCampaignRepository(), actor))
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: { code: 'bad_request', message: error.issues[0]?.message ?? 'Invalid campaign request' } }, { status: 400 })
    return winnrErrorResponse(error)
  }
}
export async function verifySenderIds(actor: WinnrAuthContext, ids?: string[]) {
  if (!ids?.length) return {}
  const pending = new Set(ids)
  let cursor: string | undefined
  let connectionId: string | undefined
  let connectionVersion: number | undefined
  const deps = buildWinnrDeps()
  // Bound provider reads; failure to finish verification never silently accepts IDs.
  for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
    const page = await listMailboxes(actor, deps, { cursor, limit: 100 })
    if (connectionId && (connectionId !== page.connectionId || connectionVersion !== page.connectionVersion)) throw new WinnrApiError(409, 'stale_connection', 'Sender connection changed; reload')
    connectionId = page.connectionId; connectionVersion = page.connectionVersion
    page.items.forEach(mailbox => pending.delete(mailbox.id))
    if (!pending.size) return { senderConnectionId: connectionId, senderConnectionVersion: connectionVersion }
    cursor = page.nextCursor ?? undefined
    if (!cursor) break
  }
  throw new WinnrApiError(400, 'bad_request', 'Selected mailboxes could not be verified in your Winnr account')
}
