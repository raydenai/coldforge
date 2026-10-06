import { NextResponse } from 'next/server'
import { resolveAuthContext, winnrErrorResponse } from '@/app/api/winnr/_shared'
import { readDashboardCounts } from '@/lib/email-core/dashboard'
export async function GET() {
  try {
    const auth = await resolveAuthContext()
    return NextResponse.json({ stats: await readDashboardCounts(auth.organizationId), coverage: 'canonical_saved_rows', providerMetrics: null })
  } catch (error) { return winnrErrorResponse(error) }
}
