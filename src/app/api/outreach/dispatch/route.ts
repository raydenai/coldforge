export const maxDuration=30
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { resolveAuthContext,assertSameOrigin,parseJsonRequest,winnrErrorResponse } from '@/app/api/winnr/_shared'
import { WinnrApiError } from '@/lib/winnr/server'
import { createEmailDispatchDeps,readEmailDispatchReadiness } from '@/lib/outreach/dispatch-runtime'
import { dispatchCampaign,retryEmailDispatch } from '@/lib/outreach/dispatch'
const configure=z.object({action:z.literal('configure'),campaignId:z.string().uuid(),senderName:z.string().trim().min(1).max(100),senderCompany:z.string().trim().min(1).max(200),businessAddress:z.string().trim().min(1).max(1000),senderEmail:z.string().email().transform(v=>v.trim().toLowerCase()),mailboxId:z.string().min(1).max(200),mailboxDailyLimit:z.number().int().min(1).max(1000)}).strict()
const execute=z.object({action:z.literal('dispatch'),campaignId:z.string().uuid(),limit:z.literal(1).default(1)}).strict()
const retry=z.object({action:z.literal('retry'),campaignId:z.string().uuid(),attemptId:z.string().uuid()}).strict()
const kill=z.object({action:z.literal('kill'),campaignId:z.string().uuid()}).strict()
async function actor(){const value=await resolveAuthContext();if(!['owner','admin'].includes(value.role))throw new WinnrApiError(403,'forbidden','Only organization owners and admins may dispatch email');return value}
export async function GET(request:NextRequest){try{const auth=await actor();const campaignId=z.string().uuid().parse(request.nextUrl.searchParams.get('campaignId'));return NextResponse.json(await readEmailDispatchReadiness(auth,campaignId,createEmailDispatchDeps(auth)))}catch(error){return winnrErrorResponse(error)}}
export async function POST(request:NextRequest){try{const auth=await actor();assertSameOrigin(request);const body=z.discriminatedUnion('action',[configure,execute,kill,retry]).parse(await parseJsonRequest(request));const deps=createEmailDispatchDeps(auth);return NextResponse.json(body.action==='retry'?await retryEmailDispatch(auth.userId,auth.organizationId,body.campaignId,body.attemptId,deps):body.action==='dispatch'?await dispatchCampaign(auth.userId,auth.organizationId,body.campaignId,body.limit,deps):await deps.repository.call(auth.userId,auth.organizationId,body.action,{...body}))}catch(error){return winnrErrorResponse(error)}}
