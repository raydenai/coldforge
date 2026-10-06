import { z } from 'zod'
import { normalizeInboundMessageId, readBoundedRequest } from '@/lib/outreach/ingestion'
const clean = z.string().min(1).max(998).refine(value => !/[\r\n\0]/.test(value))
const mapping = z.object({ original_message_id: clean, provider_message_id: clean, recipient: z.email(), sender: z.email(), relayed_at: z.iso.datetime(), provider: z.string().optional(), sending_domain: z.string().optional() })
export const inboundEmailSchema = z.object({ uid: clean, message_id: clean.transform(normalizeInboundMessageId), mailbox: z.email(), from_email: z.email().optional(), from: z.string().max(2000), to: z.string().max(2000), subject: z.string().max(2000).optional(), received_at: z.iso.datetime(), in_reply_to: clean.transform(normalizeInboundMessageId).optional(), references: z.string().max(10000).optional() })
const webhook = z.object({ id: clean, url: z.url(), events: z.array(z.string()), status: z.enum(['enabled','disabled','auto_disabled']) })
export function createWinnrInboundProvider(token: string, request: typeof fetch = fetch, deadlineAt?: number) {
 async function get(path: string) {
  const remaining = deadlineAt === undefined ? 7000 : Math.max(0, deadlineAt - Date.now())
  const timeout = Math.min(7000, remaining)
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),timeout)
  try { if(remaining<=0) throw new Error('deadline'); const response=await request(`https://api.winnr.app${path}`,{method:'GET',redirect:'manual',credentials:'omit',headers:{Authorization:`Bearer ${token}`},signal:controller.signal});if(!response.ok || response.redirected) throw new Error();return JSON.parse((await readBoundedRequest({body:response.body},1048576,timeout)).toString('utf8')) }
  catch { throw new Error('Winnr inbound read unavailable') } finally { clearTimeout(timer) }
 }
 return {
  async webhook(id:string) { return z.object({data:webhook}).parse(await get(`/v1/webhooks/${encodeURIComponent(clean.parse(id))}`)).data },
  async secret(id:string) { return z.object({data:z.object({webhook_id:clean,secret:z.string().regex(/^whsec_/).max(1000)})}).parse(await get(`/v1/webhooks/${encodeURIComponent(clean.parse(id))}/secret`)).data },
  async mappings(providerId:string) { return z.object({data:z.array(mapping).max(200)}).parse(await get(`/v1/messages/lookup?provider_message_id=${encodeURIComponent(clean.parse(providerId))}`)).data },
  async list(mailbox:string,cursor?:string) { const q=new URLSearchParams({mailbox:z.email().parse(mailbox),exclude_warmup:'true',limit:'20'});if(cursor)q.set('cursor',cursor);return z.object({data:z.array(inboundEmailSchema).max(200),pagination:z.object({has_more:z.boolean(),cursor:z.string().nullable().optional()})}).parse(await get(`/v1/inbox?${q}`)) },
  async body(uid:string,mailbox:string) { return z.object({data:z.object({uid:clean,mailbox:z.email(),body:z.string().max(1000000)})}).parse(await get(`/v1/inbox/${encodeURIComponent(clean.parse(uid))}/body?mailbox=${encodeURIComponent(z.email().parse(mailbox))}`)).data },
 }
}
export type WinnrInboundProvider = ReturnType<typeof createWinnrInboundProvider>
