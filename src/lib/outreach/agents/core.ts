import { z } from 'zod';
const text = z.string().trim().min(1).max(4000);
export const intentSchema = z.enum(['interested', 'question', 'objection', 'notnow', 'wrongperson', 'optout', 'hostile', 'uncertain', 'ooo']);
export const briefSchema = z.object({ audience: text, problem: text, offer: text, tone: text, cta: text, exclusions: z.array(text).max(30).default([]), claims: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(80), text, evidence: text, source: text })).max(30).default([]), faqs: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]+$/).max(80), intent: intentSchema, question: text, answer: text })).max(30).default([]) }).strict().superRefine((v, c) => { for (const rows of [v.claims, v.faqs])
    if (new Set(rows.map(x => x.id)).size !== rows.length)
        c.addIssue({ code: 'custom', message: 'Duplicate reference IDs' }); });
export const policySchema = z.object({ enabled: z.boolean().default(false), allowedIntents: z.array(intentSchema).max(4).default(['question']), minConfidence: z.number().min(0.9).max(1).default(0.95), maxReplies: z.number().int().min(1).max(3).default(1), dailyCalls: z.number().int().min(1).max(200).default(20), startHour: z.number().int().min(0).max(23).default(9), endHour: z.number().int().min(1).max(24).default(17) }).strict().refine(v => v.startHour < v.endHour, 'UTC window must not cross midnight').refine(v => v.allowedIntents.every(i => ['question', 'interested', 'objection'].includes(i)), 'Unsupported autonomous intent');
export const classificationSchema = z.object({ intent: intentSchema, confidence: z.number().min(0).max(1), reason: z.string().max(1000), templateId: z.string().max(80).nullable().default(null), source: z.enum(['deterministic', 'model']).default('model'), model: z.string().max(120).optional(), promptVersion: z.string().max(100).optional(), policyVersion: z.number().int().optional() }).strict();
export type Brief = z.infer<typeof briefSchema>;
export type Policy = z.infer<typeof policySchema>;
export type Classification = z.infer<typeof classificationSchema>;
export function classifyDeterministically(body: string): Classification | null {
    const reason = /\b(unsubscribe|opt.?out|remove me|stop (emailing|contacting|sending))\b/i.test(body) ? 'optout' : /automatic reply|auto.?reply|out of (the )?office|on vacation/i.test(body) ? 'ooo' : /ignore .{0,40}instructions|disregard .{0,40}(instructions|rules)|system( prompt|:)|send (the |your )?(password|secret)|<\/?system>/i.test(body) ? 'uncertain' : null;
    return reason ? { intent: reason, confidence: 1, reason: 'Deterministic safety marker; operator review required', templateId: null, source: 'deterministic' } : null;
}
export function chooseReply(brief: Brief, policy: Policy, classification: Classification): string | null {
    if (!policy.enabled || classification.source === 'deterministic' || classification.confidence < policy.minConfidence || !policy.allowedIntents.includes(classification.intent))
        return null;
    const faq = brief.faqs.find(f => f.id === classification.templateId && f.intent === classification.intent);
    if (faq && (/\{\{|\$\{/.test(faq.answer) || /appointment.{0,30}(confirmed|booked)|i( have|'ve)? booked|we will call|call you|you (consent|agreed)/i.test(faq.answer) || brief.exclusions.some(exclusion => faq.answer.toLowerCase().includes(exclusion.toLowerCase()))))
        return null;
    return faq?.answer ?? null;
}
export const copySchema = z.object({ subject: z.string().trim().min(1).max(200).refine(v => !/[\r\n]/.test(v)), body: z.string().trim().min(1).max(12000), claimIds: z.array(z.string()).max(30) }).strict();
export function validateCopy(brief: Brief, raw: unknown) {
    const copy = copySchema.parse(raw), claims = copy.claimIds.map(id => { const claim = brief.claims.find(c => c.id === id); if (!claim)
        throw Error('Unsupported claim reference'); return claim.text; });
    if (/\{\{|\}\}/.test(copy.body + copy.subject))
        throw Error('Unsupported personalization variable');
    // Free prose cannot establish factual truth. Only exact supplied, attributed fragments are accepted.
    if (brief.exclusions.some(exclusion => (copy.subject + ' ' + copy.body).toLowerCase().includes(exclusion.toLowerCase())))
        throw Error('Copy includes excluded content');
    const fragments = [...claims, brief.offer, brief.problem, brief.cta].sort((a, b) => b.length - a.length);
    let remaining = copy.body;
    for (const fragment of fragments)
        remaining = remaining.split(fragment).join('');
    if (remaining.replace(/[\s.,!?;:\-]/g, ''))
        throw Error('Copy includes unsupported text or proof');
    if (![brief.offer, brief.problem, ...claims].includes(copy.subject))
        throw Error('Subject must use supplied facts');
    return copy;
}
export const modelConfigSchema = z.object({ model: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9._:-]+$/), apiKey: z.string().min(12).max(500).optional(), expectedRevision: z.number().int().nonnegative() }).strict();
export const stateSchema = z.object({ model: z.object({ revision: z.number(), model: z.string(), configured: z.boolean() }).nullable(), briefs: z.array(z.object({ campaign_id: z.uuid(), revision: z.number(), brief: briefSchema })), policies: z.array(z.object({ campaign_id: z.uuid(), revision: z.number(), policy: policySchema })), drafts: z.array(z.object({ id: z.uuid(), campaign_id: z.uuid(), brief_revision: z.number(), content: z.object({ subject: z.string(), body: z.string(), claimIds: z.array(z.string()) }), approved_at: z.string().nullable(), approved_campaign_revision: z.string().nullable() })), runs: z.array(z.object({ id: z.uuid(), kind: z.string(), status: z.string(), model: z.string(), served_model: z.string().nullable().optional(), prompt_version: z.string(), created_at: z.string(), error_code: z.string().nullable() })), decisions: z.array(z.object({ id: z.uuid(), thread_id: z.uuid(), approved: z.boolean(), classification: classificationSchema, policy_revision: z.number(), source_reply_id: z.uuid() })) });
export type AgentState = z.infer<typeof stateSchema>;
/** Absolute caller budget, never reset at a downstream phase. */
export function remainingAgentTime(deadlineAt:number|undefined,cap:number):number{const remaining=deadlineAt===undefined?cap:Math.min(cap,deadlineAt-Date.now());if(remaining<=0)throw Error('Agent deadline exhausted');return Math.max(1,remaining)}
