import { NextResponse, type NextRequest } from 'next/server';
import { resolveAuthContext, assertSameOrigin, winnrErrorResponse } from '@/app/api/winnr/_shared';
import { requireAgentManager } from '@/lib/outreach/agents/service';
/** Legacy free-form paid generation bypass is retired. Approved brief workflow is /api/outreach/agents. */
export async function POST(request: NextRequest) { try {
    const actor = await resolveAuthContext();
    assertSameOrigin(request);
    requireAgentManager(actor);
    return NextResponse.json({ error: 'Use the Agents offer brief and draft approval workflow', href: '/agents' }, { status: 410 });
}
catch (error) {
    return winnrErrorResponse(error);
} }
