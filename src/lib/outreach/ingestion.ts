import { createHash } from 'node:crypto'
import { z } from 'zod'
import addressparser from 'nodemailer/lib/addressparser'
import { verifyWinnrSignature } from '@/lib/winnr/webhook'
import { WinnrApiError } from '@/lib/winnr/server'
const id = z.string().min(1).max(998).refine(value => !/[\r\n\0]/.test(value))
const email = z.email().transform(value => value.toLowerCase())
export function parseSingleInboundAddress(value: string): string {
 if (/[\r\n\0]/.test(value)) throw new Error('Invalid inbound address')
 const addresses = addressparser(value, { flatten: true })
 if (addresses.length !== 1 || !addresses[0]) throw new Error('Ambiguous inbound address')
 return z.email().parse(addresses[0].address).toLowerCase()
}
const fromAddress = z.string().max(2000).transform((value, ctx) => { try { return parseSingleInboundAddress(value) } catch { ctx.addIssue({code:'custom',message:'Invalid inbound address'});return z.NEVER } })
const rfcId = id.transform(value => value.startsWith('<') ? value : `<${value}>`).pipe(z.string().regex(/^<[^<>\s@]+@[^<>\s@]+>$/))
export function normalizeInboundMessageId(value: string): string { return rfcId.parse(value) }
const received = z.object({ mailbox: email, from: fromAddress, subject: z.string().max(2000).optional(), message_id: rfcId, received_at: z.iso.datetime().optional(), in_reply_to: rfcId.optional(), references: z.union([z.string().max(10000), z.array(rfcId).max(100)]).optional() })
const relayed = z.object({ original_message_id: rfcId, provider_message_id: rfcId, recipient: email, sender: email, provider: z.string().max(100).optional(), sending_domain: z.string().max(253).optional(), relayed_at: z.iso.datetime().optional() })
const adverse = z.object({ recipient: email, sender: email, sending_domain: z.string().max(253).optional(), bounce_type: z.enum(['hard','soft']).optional(), diagnostic: z.string().max(4000).optional(), bounced_at: z.iso.datetime().optional(), complained_at: z.iso.datetime().optional() })
const envelope = z.object({ id: z.string().regex(/^evt_[A-Za-z0-9_-]+$/).max(200), object: z.literal('event'), type: z.enum(['email.received','message.relayed','email.bounced','email.complained','test.ping']), api_version: z.string().max(100), created: z.iso.datetime(), account_id: z.string().min(1).max(200), data: z.unknown() })
export function parseWinnrInboundEvent(raw: unknown) {
 const e = envelope.parse(raw)
 const data = e.type === 'email.received' ? received.parse(e.data) : e.type === 'message.relayed' ? relayed.parse(e.data) : e.type === 'test.ping' ? z.object({}).parse(e.data) : adverse.parse(e.data)
 if (e.type === 'email.received') {
  const message = received.parse(data)
  if (!message.in_reply_to && message.references) {
   const refs = Array.isArray(message.references) ? message.references : (message.references.match(/<[^<>\s]+>/g) ?? [])
   const last = refs.at(-1)
   if (last) message.in_reply_to = rfcId.parse(last)
  }
  return { ...e, data: message }
 }
 return { ...e, data }
}
export type WinnrInboundEvent = ReturnType<typeof parseWinnrInboundEvent>
export interface IngestionEndpoint { id: string; organizationId: string; connectionId: string; connectionVersion: number; providerAccountId: string; secret: string }
export interface IngestionReceiverDeps { endpoint(id: string): Promise<IngestionEndpoint | null>; persist(endpoint: IngestionEndpoint, event: WinnrInboundEvent, fingerprint: string): Promise<{duplicate:boolean;eventId:string}> }
export async function receiveWinnrEvent(endpointId: string, raw: Buffer, headers: {timestamp:string|null;signature:string|null;eventId:string|null;eventType:string|null}, deps: IngestionReceiverDeps, now = Date.now()) {
 if (raw.length > 65536) throw new WinnrApiError(413,'bad_request','Webhook too large')
 const endpoint = await deps.endpoint(endpointId)
 if (!endpoint || !verifyWinnrSignature(raw,headers,endpoint.secret,now)) throw new WinnrApiError(401,'unauthenticated','Invalid webhook signature')
 const event = parseWinnrInboundEvent(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)))
 if (event.account_id !== endpoint.providerAccountId || headers.eventId !== event.id || headers.eventType !== event.type) throw new WinnrApiError(403,'forbidden','Webhook identity mismatch')
 return deps.persist(endpoint,event,createHash('sha256').update(raw).digest('hex'))
}
export function isDeterministicOptOut(body: string): boolean { return /^(?:unsubscribe|remove me|stop(?: emailing me)?|please (?:remove me|unsubscribe me))\s*[.!]?$/i.test(body.trim()) }
/** Stream deadline bounds both unauthenticated receiver and provider bodies. */
export async function readBoundedRequest(request: Pick<Request, 'body'>, max = 65536, milliseconds = 5000): Promise<Buffer> {
 const reader = request.body?.getReader(); if (!reader) return Buffer.alloc(0)
 const chunks: Uint8Array[] = []; let size=0; let timer: ReturnType<typeof setTimeout> | undefined
 const read = async () => { for (;;) { const item=await reader.read(); if(item.done) return Buffer.concat(chunks);size+=item.value.length;if(size>max) throw new WinnrApiError(413,'bad_request','Request too large');chunks.push(item.value) } }
 try { return await Promise.race([read(),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Read deadline')),milliseconds)})]) } finally { clearTimeout(timer);void reader.cancel().catch(()=>{}) }
}
