import { type NextRequest } from 'next/server'
import { campaignPatch } from '@/lib/campaigns/core'
import { campaignRoute, idSchema, parseJsonRequest, verifySenderIds, type RouteParams } from '../_shared'
export async function GET(request: NextRequest, context: RouteParams) {
  return campaignRoute(request, false, async (repo, actor) => ({ campaign: await repo.get(actor.organizationId, idSchema.parse((await context.params).id)) }))
}
export async function PUT(request: NextRequest, context: RouteParams) {
  return campaignRoute(request, true, async (repo, actor) => {
    const id = idSchema.parse((await context.params).id)
    const { expectedUpdatedAt, ...input } = campaignPatch.parse(await parseJsonRequest(request))
    const senders = await verifySenderIds(actor, input.mailboxIds)
    return repo.mutate(actor.userId, actor.organizationId, id, 'settings', { ...input, ...senders }, expectedUpdatedAt)
  })
}
export async function DELETE(request: NextRequest, context: RouteParams) {
  return campaignRoute(request, true, async (repo, actor) => repo.mutate(actor.userId, actor.organizationId, idSchema.parse((await context.params).id), 'delete'))
}
