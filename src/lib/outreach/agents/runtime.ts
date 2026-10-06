import { createAgentRepository } from './database';
import { createModelPort } from './model';
import { createReplyDeps } from '@/lib/outreach/replies-runtime';
import type { WinnrAuthContext } from '@/lib/winnr/server';
export function createAgentDeps(actor: WinnrAuthContext,deadlineAt?:number) { return { repository: createAgentRepository(deadlineAt), model: createModelPort({deadlineAt}), replyDeps: createReplyDeps(actor,Date.now(),deadlineAt) }; }
