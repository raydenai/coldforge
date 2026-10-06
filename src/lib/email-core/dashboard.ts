import { createClient } from '@/lib/supabase/server'
export async function readDashboardCounts(organizationId: string) {
  const database = await createClient()
  const [campaigns, leads, unread] = await Promise.all([
    database.from('campaigns').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId),
    database.from('leads').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId),
    database.from('replies').select('id', { count: 'exact', head: true }).eq('organization_id', organizationId).eq('status', 'unread'),
  ])
  return { totalCampaigns: campaigns.error ? null : campaigns.count, totalLeads: leads.error ? null : leads.count, unreadReplies: unread.error ? null : unread.count }
}
