import { type NextRequest } from 'next/server'
import { z } from 'zod'
import { enrollmentInput } from '@/lib/campaigns/core'
import { campaignRoute, idSchema, paging, parseJsonRequest, type RouteParams } from '../../_shared'
export async function GET(request: NextRequest, context: RouteParams) {
  return campaignRoute(request, false, async (repo, actor) => {
    const { page, limit } = paging.parse(Object.fromEntries(request.nextUrl.searchParams))
    const status = z.enum(['all', 'pending', 'in_progress', 'completed', 'replied', 'bounced', 'unsubscribed']).optional().parse(request.nextUrl.searchParams.get('status') ?? undefined)
    const search = z.string().max(200).optional().parse(request.nextUrl.searchParams.get('search') ?? undefined)
    return repo.leads(actor.organizationId, idSchema.parse((await context.params).id), page, limit, status, search)
  })
}
export async function POST(request: NextRequest, context: RouteParams) {
  return campaignRoute(request, true, async (repo, actor) => {
    const input = enrollmentInput.parse(await parseJsonRequest(request))
    const result = await repo.mutate(actor.userId, actor.organizationId, idSchema.parse((await context.params).id), 'enroll', input)
    return { ...result, imported: result.added, addedCount: result.added }
  })
}
