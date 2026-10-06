import { type NextRequest } from 'next/server'
import { campaignRoute, idSchema, type RouteParams } from '../../_shared'
export async function GET(request: NextRequest, context: RouteParams) {
  return campaignRoute(request, false, async (repo, actor) => {
    const campaign = await repo.get(actor.organizationId, idSchema.parse((await context.params).id))
    // Persisted campaign totals are available; provider receipts/time-series are not.
    return { stats: campaign.stats, dailyStats: null, evidence: 'stored_campaign_totals', deliveryVerified: false }
  })
}
