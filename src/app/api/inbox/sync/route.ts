import { NextResponse,type NextRequest } from 'next/server'
import { resolveAuthContext,assertSameOrigin,winnrErrorResponse } from '@/app/api/winnr/_shared'
import { syncIngestion,requireIngestionManager } from '@/lib/outreach/ingestion-service'
export async function POST(request:NextRequest){try{const actor=await resolveAuthContext();assertSameOrigin(request);requireIngestionManager(actor);return NextResponse.json(await syncIngestion(actor,await request.json()))}catch(error){return winnrErrorResponse(error)}}
export { GET } from '@/app/api/outreach/ingestion/route'
