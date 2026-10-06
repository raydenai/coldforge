import { NextResponse,type NextRequest } from 'next/server'
import { z } from 'zod'
import { resolveAuthContext,assertSameOrigin,winnrErrorResponse,parseJsonRequest } from '@/app/api/winnr/_shared'
import { requireIngestionManager } from '@/lib/outreach/ingestion-service'
import { createReplyDeps } from '@/lib/outreach/replies-runtime'
import { sendManualReply,replyInputSchema } from '@/lib/outreach/replies'
export const maxDuration=30
export async function POST(request:NextRequest,{params}:{params:Promise<{id:string}>}){const startedAt=Date.now();try{const actor=await resolveAuthContext();assertSameOrigin(request);requireIngestionManager(actor);const id=z.uuid().parse((await params).id);const input=replyInputSchema.parse(await parseJsonRequest(request));return NextResponse.json(await sendManualReply(actor.userId,actor.organizationId,id,input,createReplyDeps(actor,startedAt)))}catch(error){return winnrErrorResponse(error)}}
