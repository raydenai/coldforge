import {remainingAgentTime} from './core';
import {fetchAgentResponse} from './model';
import { createClient } from '@supabase/supabase-js';
import { decrypt } from '@/lib/encryption';
import { getServiceRoleConfig } from '@/lib/winnr/database';
import { WinnrApiError } from '@/lib/winnr/server';
export { stateSchema, type AgentState } from './core';
type Json = null | boolean | string | number | Json[] | {
    [key: string]: Json | undefined;
};
interface Database {
    public: {
        Tables: {
            outreach_agent_models: {
                Row: {
                    organization_id: string;
                    revision: number;
                    model: string;
                    api_key_ciphertext: string | null;
                };
                Insert: never;
                Update: never;
                Relationships: [
                ];
            };
        };
        Views: {
            [_ in never]: never;
        };
        Functions: {
            outreach_agent_mutate: {
                Args: {
                    p_actor: string;
                    p_org: string;
                    p_action: string;
                    p_payload: Json;
                };
                Returns: Json;
            };
        };
        Enums: {
            [_ in never]: never;
        };
        CompositeTypes: {
            [_ in never]: never;
        };
    };
}
export interface AgentRepository {
    call(actor: string, org: string, action: string, payload?: Json,deadlineAt?:number): Promise<unknown>;
    key(org: string, model: string,deadlineAt?:number): Promise<string>;
}
export function createAgentRepository(deadlineAt?:number): AgentRepository {
    const config = getServiceRoleConfig();
    const client = createClient<Database>(config.url, config.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (input, init) => fetchAgentResponse(fetch,input,init,deadlineAt,5000,2097152) } });
    return { async call(actor, org, action, payload = {},callDeadline=deadlineAt) { const { data, error } = await client.rpc('outreach_agent_mutate', { p_actor: actor, p_org: org, p_action: action, p_payload: payload }).abortSignal(AbortSignal.timeout(remainingAgentTime(callDeadline,5000))); if (error) {
            const code = /agents:([a-z_]+)/.exec(error.message)?.[1];
            const messages:Record<string,string>={stale_body:'Canonical message body changed; stale classification is held',stale:'Agent configuration or campaign changed; reload',body_required:'Sync the canonical inbox message body before classification',disabled:'Enable a conversation policy before preparing automation',not_found:'Campaign or conversation not found',event_rejected:'Decision persistence failed; no action was committed'};
            throw new WinnrApiError(code==='forbidden'?403:code==='event_rejected'?500:code==='not_found'?404:code==='stale'||code==='stale_body'||code==='body_required'||code==='disabled'?409:400,code==='forbidden'?'forbidden':code==='event_rejected'?'internal_error':'bad_request',messages[code??'']??'Agent operation was not accepted');
        } return data; }, async key(org, model,keyDeadline=deadlineAt) { const { data, error } = await client.from('outreach_agent_models').select('model,api_key_ciphertext').eq('organization_id', org).abortSignal(AbortSignal.timeout(remainingAgentTime(keyDeadline,5000))).maybeSingle(); if (error || !data?.api_key_ciphertext || data.model !== model)
            throw new WinnrApiError(503, 'service_unavailable', 'AI model configuration unavailable'); try {
            return decrypt(data.api_key_ciphertext);
        }
        catch {
            throw new WinnrApiError(503, 'service_unavailable', 'AI key unavailable');
        } } };
}
