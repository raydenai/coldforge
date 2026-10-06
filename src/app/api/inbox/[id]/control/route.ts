import { NextResponse,type NextRequest } from 'next/server'
import { z } from 'zod'
import { resolveAuthContext,assertSameOrigin,winnrErrorResponse,parseJsonRequest } from '@/app/api/winnr/_shared'
import { requireIngestionManager } from '@/lib/outreach/ingestion-service'
import { createReplyRepository } from '@/lib/outreach/replies-database'
export async function POST(request:NextRequest,{params}:{params:Promise<{id:string}>}){try{const actor=await resolveAuthContext();assertSameOrigin(request);requireIngestionManager(actor);const threadId=z.uuid().parse((await params).id);const input=z.object({mode:z.enum(['human','assist','autonomous']),expectedRevision:z.number().int().positive()}).strict().parse(await parseJsonRequest(request));return NextResponse.json(await createReplyRepository().call(actor.userId,actor.organizationId,'control',{threadId,...input}))}catch(error){return winnrErrorResponse(error)}}
