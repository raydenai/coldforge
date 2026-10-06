import Link from 'next/link'
import { readDashboardCounts } from '@/lib/email-core/dashboard'
import { resolveAuthContext } from '@/app/api/winnr/_shared'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

export default async function DashboardPage() {
  let campaigns: number | null = null
  let leads: number | null = null
  let unread: number | null = null
  try {
    const auth = await resolveAuthContext()
    const measured = await readDashboardCounts(auth.organizationId)
    campaigns = measured.totalCampaigns
    leads = measured.totalLeads
    unread = measured.unreadReplies
  } catch { /* Unavailable membership or storage remains unknown, never zero. */ }
  return <div className="space-y-6">
    <div><h1 className="text-3xl font-bold">Email workspace</h1><p className="text-muted-foreground">Your saved campaigns, leads, and conversations.</p></div>
    <div className="grid gap-4 md:grid-cols-3">{[
      { label: 'Campaigns', value: campaigns, href: '/campaigns' },
      { label: 'Leads', value: leads, href: '/leads' },
      { label: 'Unread replies', value: unread, href: '/inbox' },
    ].map(metric => <Link key={metric.href} href={metric.href}><Card><CardHeader><CardTitle>{metric.label}</CardTitle></CardHeader><CardContent><p className="text-3xl font-semibold">{metric.value === null ? 'Unavailable' : metric.value.toLocaleString()}</p></CardContent></Card></Link>)}</div>
    <Card><CardHeader><CardTitle>Mailbox setup</CardTitle></CardHeader><CardContent className="space-y-3"><p>Connect and manage your mailboxes and warming in Winnr. Open Winnr to measure provider status.</p><Link className="underline" href="/winnr">Open Winnr</Link></CardContent></Card>
    <Card><CardHeader><CardTitle>Execution readiness</CardTitle></CardHeader><CardContent><p>Campaign sending, manual replies, and new message ingestion are unavailable until the durable Winnr transport is integrated. You can prepare campaigns, import leads, and read saved conversations.</p></CardContent></Card>
  </div>
}
