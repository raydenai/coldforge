import { createEmailDispatchDeps,activateEmailCampaign } from '@/lib/outreach/dispatch-runtime'
import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { campaignRoute, idSchema, parseJsonRequest, type RouteParams } from '../../_shared'
const inputSchema = z.object({ action: z.enum(['start', 'resume', 'pause', 'complete', 'archive']) }).strict()
export async function POST(request: NextRequest, context: RouteParams) {
  return campaignRoute(request, true, async (repo, actor) => {
    const { action } = inputSchema.parse(await parseJsonRequest(request))
    const campaignId=idSchema.parse((await context.params).id)
    if(action==='start'||action==='resume')return activateEmailCampaign(actor,campaignId,action,createEmailDispatchDeps(actor))
    const result = await repo.mutate(actor.userId, actor.organizationId, idSchema.parse((await context.params).id), action)
    return { ...result, success: true, status: result.campaign?.status }
  })
}
