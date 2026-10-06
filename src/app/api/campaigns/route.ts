import { type NextRequest } from 'next/server'
import { campaignInput, campaignStatus } from '@/lib/campaigns/core'
import { campaignRoute, paging, parseJsonRequest, verifySenderIds } from './_shared'
export async function GET(request: NextRequest) {
  return campaignRoute(request, false, async (repo, actor) => {
    const { page, limit } = paging.parse(Object.fromEntries(request.nextUrl.searchParams))
    const status = request.nextUrl.searchParams.get('status')
    return repo.list(actor.organizationId, page, limit, status ? campaignStatus.parse(status) : undefined)
  })
}
export async function POST(request: NextRequest) {
  return campaignRoute(request, true, async (repo, actor) => {
    const input = campaignInput.parse(await parseJsonRequest(request))
    const senders = await verifySenderIds(actor, input.mailboxIds)
    return repo.mutate(actor.userId, actor.organizationId, null, 'create', { ...input, ...senders })
  })
}
