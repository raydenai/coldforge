import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { WinnrApiError } from '@/lib/winnr/server';
import { encrypt } from '@/lib/encryption';
import { resolveAuthContext, assertSameOrigin, winnrErrorResponse } from '@/app/api/winnr/_shared';
import { briefSchema, policySchema, modelConfigSchema, copySchema,remainingAgentTime } from '@/lib/outreach/agents/core';
import { createAgentRepository, stateSchema } from '@/lib/outreach/agents/database';
import { requireAgentManager, runCopy, processEligibleReply, saveManualDraft } from '@/lib/outreach/agents/service';
import { createModelPort } from '@/lib/outreach/agents/model';
import { createReplyDeps } from '@/lib/outreach/replies-runtime';
const actionSchema = z.discriminatedUnion('action', [
    modelConfigSchema.extend({ action: z.literal('model') }),
    z.object({ action: z.literal('brief'), campaignId: z.uuid(), expectedRevision: z.number().int().nonnegative(), brief: briefSchema }).strict(),
    z.object({ action: z.literal('policy'), campaignId: z.uuid(), expectedRevision: z.number().int().nonnegative(), policy: policySchema }).strict(),
    z.object({ action: z.literal('copy'), campaignId: z.uuid() }).strict(),
    z.object({ action: z.literal('manualDraft'), campaignId: z.uuid(), copy: copySchema }).strict(),
    z.object({ action: z.literal('approveDraft'), runId: z.uuid() }).strict(),
    z.object({ action: z.literal('applyDraft'), runId: z.uuid(), stepId: z.string().min(1), expectedUpdatedAt: z.string().min(1) }).strict(),
    z.object({ action: z.literal('process'), threadId: z.uuid() }).strict(),
]);
async function readBoundedBody(request: NextRequest,deadlineAt:number): Promise<unknown> { const reader = request.body?.getReader(); if (!reader)
    return {}; const timer=setTimeout(()=>{void reader.cancel().catch(()=>undefined)},remainingAgentTime(deadlineAt,30000));try{ const chunks: Uint8Array[] = []; let size = 0; for (;;) {
    const chunk = await reader.read();remainingAgentTime(deadlineAt,30000);
    if (chunk.done)
        break;
    size += chunk.value.byteLength;
    if (size > 64000) {
        await reader.cancel();
        throw new WinnrApiError(413, 'bad_request', 'Request too large');
    }
    chunks.push(chunk.value);
} return JSON.parse(Buffer.concat(chunks).toString('utf8')); }finally{clearTimeout(timer);reader.releaseLock()} }
export async function GET() { const deadlineAt=Date.now()+15000;try {
    const actor = await resolveAuthContext();
    requireAgentManager(actor);
    return NextResponse.json(stateSchema.parse(await createAgentRepository(deadlineAt).call(actor.userId, actor.organizationId, 'read',{},deadlineAt)));
}
catch (error) {
    return winnrErrorResponse(error);
} }
export async function POST(request: NextRequest) {
    const startedAt=Date.now(),deadlineAt=startedAt+30000;
    try {
        const actor = await resolveAuthContext();
        assertSameOrigin(request);
        requireAgentManager(actor);
        if (Number(request.headers.get('content-length') ?? 0) > 64000)
            return NextResponse.json({ error: 'Request too large' }, { status: 413 });
        const input = actionSchema.parse(await readBoundedBody(request,deadlineAt)), repo = createAgentRepository(deadlineAt);
        if (input.action === 'model')
            return NextResponse.json(await repo.call(actor.userId, actor.organizationId, 'model', { expectedRevision: input.expectedRevision, model: input.model, ...(input.apiKey ? { ciphertext: encrypt(input.apiKey) } : {}) },deadlineAt));
        if (input.action === 'manualDraft')
            return NextResponse.json(await saveManualDraft(actor, input.campaignId, input.copy, repo,deadlineAt));
        if (input.action === 'copy')
            return NextResponse.json(await runCopy(actor, input.campaignId, repo, createModelPort({deadlineAt}),deadlineAt));
        if (input.action === 'process')
            return NextResponse.json(await processEligibleReply(actor, input.threadId, repo, createModelPort({deadlineAt}), createReplyDeps(actor,startedAt,deadlineAt), true,deadlineAt));
        if (input.action === 'applyDraft')
            return NextResponse.json(await repo.call(actor.userId, actor.organizationId, 'applyDraft', { runId: input.runId, stepId: input.stepId, expectedUpdatedAt: input.expectedUpdatedAt },deadlineAt));
        return NextResponse.json(await repo.call(actor.userId, actor.organizationId, input.action, input.action === 'brief' ? { campaignId: input.campaignId, expectedRevision: input.expectedRevision, brief: input.brief } : input.action === 'policy' ? { campaignId: input.campaignId, expectedRevision: input.expectedRevision, policy: input.policy } : { runId: input.runId },deadlineAt));
    }
    catch (error) {
        return winnrErrorResponse(error);
    }
}
