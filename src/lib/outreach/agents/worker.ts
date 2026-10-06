import {remainingAgentTime} from './core';
import { z } from 'zod';
import type { WinnrAuthContext } from '@/lib/winnr/server';
import { replyContextSchema, executePreparedReply } from '@/lib/outreach/replies';
import { dispatchMessageSchema, fingerprintDispatchMessage, type DispatchDeps } from '@/lib/outreach/dispatch';
import type { AgentRepository } from './database';
import type { ModelPort } from './model';
import { processEligibleReply, requireAgentManager } from './service';
import { createAgentDeps } from './runtime';
export interface AgentWorkerDeps {
    repository: AgentRepository;
    model: ModelPort;
    replyDeps: DispatchDeps;
}
export interface AgentWorkerResult {
    status: 'idle' | 'completed' | 'held' | 'blocked';
    phase: 'decision' | 'reply';
    threadId?: string;
    decisionId?: string;
    attemptId?: string;
    modelCalls: number;
    smtpAttempts: number;
    reason?: string;
}
/** Phase A: at most one model call, never SMTP. */
export async function processNextAgentDecision(actor: WinnrAuthContext, deps?: AgentWorkerDeps,deadlineAt?:number): Promise<AgentWorkerResult> {
    requireAgentManager(actor);remainingAgentTime(deadlineAt,5000);
    const ports = deps ?? createAgentDeps(actor,deadlineAt);
    const next = z.object({ threadId: z.uuid().nullable() }).parse(await ports.repository.call(actor.userId, actor.organizationId, 'nextDecision',{},deadlineAt));
    if (!next.threadId)
        return { status: 'idle', phase: 'decision', modelCalls: 0, smtpAttempts: 0 };
    let modelCalls = 0;
    const countedModel: ModelPort = { generate(input) { modelCalls++; return ports.model.generate({...input,deadlineAt:input.deadlineAt??deadlineAt}); } };
    try {
        const result = await processEligibleReply(actor, next.threadId, ports.repository, countedModel, ports.replyDeps, true,deadlineAt);
        if ('held' in result)
            return { status: 'held', phase: 'decision', threadId: next.threadId, modelCalls, smtpAttempts: 0, reason: result.held };
        return { status: 'completed', phase: 'decision', threadId: next.threadId, decisionId: 'decision' in result ? result.decision.decisionId : undefined, modelCalls, smtpAttempts: 0 };
    }
    catch {
        return { status: modelCalls ? 'held' : 'blocked', phase: 'decision', threadId: next.threadId, modelCalls, smtpAttempts: 0, reason: 'agent_configuration_or_context_changed' };
    }
}
/** Phase B: consumes immutable approved prepared content; at most one shared029 SMTP attempt. */
export async function executeNextApprovedAgentReply(actor: WinnrAuthContext, deps?: AgentWorkerDeps,deadlineAt?:number): Promise<AgentWorkerResult> {
    requireAgentManager(actor);remainingAgentTime(deadlineAt,5000);
    const ports = deps ?? createAgentDeps(actor,deadlineAt);
    const next = z.object({ decisionId: z.uuid().nullable(), prepared: z.object({ context: replyContextSchema, message: dispatchMessageSchema, fingerprint: z.string() }).optional() }).parse(await ports.repository.call(actor.userId, actor.organizationId, 'nextApproved',{},deadlineAt));
    if (!next.decisionId || !next.prepared)
        return { status: 'idle', phase: 'reply', modelCalls: 0, smtpAttempts: 0 };
    if (fingerprintDispatchMessage(next.prepared.message) !== next.prepared.fingerprint)
        return { status: 'blocked', phase: 'reply', decisionId: next.decisionId, modelCalls: 0, smtpAttempts: 0, reason: 'prepared_content_changed' };
    try {
        const result = await executePreparedReply(actor.userId, actor.organizationId, next.prepared, 'agent', next.decisionId, ports.replyDeps);
        return { status: result.accepted ? 'completed' : 'held', phase: 'reply', decisionId: next.decisionId, attemptId: result.attemptId, modelCalls: 0, smtpAttempts: 1, reason: result.accepted ? undefined : 'smtp_outcome_or_settlement_held' };
    }
    catch {
        return { status: 'blocked', phase: 'reply', decisionId: next.decisionId, modelCalls: 0, smtpAttempts: 0, reason: 'reply_authorization_or_setup_changed' };
    }
}
