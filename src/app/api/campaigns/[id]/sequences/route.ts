import { type NextRequest } from 'next/server'
import { sequenceInput, sequenceToRows } from '@/lib/campaigns/core'
import { campaignRoute, idSchema, parseJsonRequest, type RouteParams } from '../../_shared'
export async function GET(request: NextRequest, context: RouteParams) {
  return campaignRoute(request, false, async (repo, actor) => repo.sequences(actor.organizationId, idSchema.parse((await context.params).id)))
}
export async function PUT(request: NextRequest, context: RouteParams) {
  return campaignRoute(request, true, async (repo, actor) => {
    const input = sequenceInput.parse(await parseJsonRequest(request))
    const id = idSchema.parse((await context.params).id)
    const result = await repo.mutate(actor.userId, actor.organizationId, id, 'sequence', { steps: sequenceToRows(input) }, input.expectedUpdatedAt)
    return { ...result, expectedUpdatedAt: result.campaign?.updatedAt }
  })
}
