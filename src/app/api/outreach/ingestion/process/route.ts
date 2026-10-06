import { NextResponse,type NextRequest } from 'next/server'
import { z } from 'zod'
import { resolveAuthContext,assertSameOrigin,winnrErrorResponse } from '@/app/api/winnr/_shared'
import { processWinnrIngestionReceipt,requireIngestionManager } from '@/lib/outreach/ingestion-service'
export async function POST(request:NextRequest){try{const actor=await resolveAuthContext();assertSameOrigin(request);requireIngestionManager(actor);const input=z.object({receiptId:z.uuid()}).strict().parse(await request.json());return NextResponse.json(await processWinnrIngestionReceipt(actor,input.receiptId))}catch(error){return winnrErrorResponse(error)}}
