import { createHash } from 'node:crypto'
import { z } from 'zod'
import { encrypt } from '@/lib/encryption'
import { createServiceRoleRepository } from '@/lib/winnr/database'
import { createWinnrSmtpRepository } from '@/lib/winnr/smtp-database'
import { createWinnrInboundProvider, type WinnrInboundProvider } from '@/lib/winnr/inbound'
import { WinnrApiError, type WinnrAuthContext } from '@/lib/winnr/server'
import { createIngestionRepository, type IngestedMessage } from './ingestion-database'
import { isDeterministicOptOut, parseSingleInboundAddress, parseWinnrInboundEvent, type IngestionEndpoint } from './ingestion'
export function ingestionCallbackUrl(origin:string|undefined,endpoint:string) {if(!origin)throw new WinnrApiError(503,'service_unavailable','Application origin required');const url=new URL(origin);if(url.protocol!=='https:'||url.username||url.password)throw new WinnrApiError(503,'service_unavailable','HTTPS application origin required');return `${url.origin}/api/winnr/webhooks/${z.uuid().parse(endpoint)}`}
export function requireIngestionManager(actor:WinnrAuthContext){if(!['owner','admin'].includes(actor.role))throw new WinnrApiError(403,'forbidden','Owner or admin required')}
export const ingestionConfigurationInput=z.object({action:z.enum(['prepare','associate']),expectedConnectionId:z.uuid(),expectedConnectionVersion:z.number().int().positive(),webhookId:z.string().min(1).max(998).optional()}).strict()
export interface IngestionServiceDeps {
 repository: ReturnType<typeof createIngestionRepository>
 connections: Pick<ReturnType<typeof createServiceRoleRepository>, 'getConnection'|'getConnectionWithToken'>
 mailboxes: Pick<ReturnType<typeof createWinnrSmtpRepository>, 'status'>
 provider: typeof createWinnrInboundProvider
}
export function createIngestionDeps(deadlineAt?:number){return{repository:createIngestionRepository(),connections:createServiceRoleRepository(deadlineAt===undefined?{}:{deadlineAt}),mailboxes:createWinnrSmtpRepository(deadlineAt===undefined?{}:{deadlineAt}),provider:createWinnrInboundProvider}}
export async function configureIngestion(actor:WinnrAuthContext,raw:unknown,origin:string|undefined,deps:IngestionServiceDeps=createIngestionDeps()) {
 requireIngestionManager(actor);const input=ingestionConfigurationInput.parse(raw);const found=await deps.connections.getConnectionWithToken(actor.organizationId)
 if(!found||found.connection.id!==input.expectedConnectionId||found.connection.version!==input.expectedConnectionVersion)throw new WinnrApiError(409,'stale_connection','Connection changed')
 if(!found.connection.permissions.includes('write'))throw new WinnrApiError(403,'forbidden','Provider write permission required for webhook setup')
 const prepared=await deps.repository.prepare(actor.userId,actor.organizationId,found.connection.id,found.connection.version)
 const callbackUrl=ingestionCallbackUrl(origin,prepared.endpointId)
 if(input.action==='prepare')return{...prepared,callbackUrl,setup:'Create the endpoint in Winnr with received, relayed, bounced and complained events, then associate its ID.',sideEffect:'Enabling email.received switches on Winnr inbox sync.'}
 if(!input.webhookId)throw new WinnrApiError(400,'bad_request','Existing webhook ID required')
 const provider=deps.provider(found.token);const remote=await provider.webhook(input.webhookId)
 if(remote.id!==input.webhookId||remote.url!==callbackUrl||remote.status!=='enabled'||!['email.received','message.relayed','email.bounced','email.complained'].every(type=>remote.events.includes(type))||remote.events.some(type=>!['email.received','message.relayed','email.bounced','email.complained'].includes(type)))throw new WinnrApiError(409,'conflict','Provider endpoint URL, status or subscriptions do not match')
 const secret=await provider.secret(remote.id);if(secret.webhook_id!==remote.id)throw new WinnrApiError(409,'conflict','Provider secret identity mismatch')
 const saved=await deps.repository.prepare(actor.userId,actor.organizationId,found.connection.id,found.connection.version,remote.id,encrypt(secret.secret),remote.events);return{...saved,callbackUrl,webhookId:remote.id,bodyFetch:'pending manual sync'}
}
/** True once an absolute request deadline has been reached. */
function deadlineReached(deadlineAt: number | undefined): boolean {
 return deadlineAt !== undefined && Date.now() >= deadlineAt
}

/** Read-only provider work port. Receipt is durable and followups stopped first. */
export async function hydrateIngestedMessage(actor:WinnrAuthContext,message:IngestedMessage,uid:string,provider:WinnrInboundProvider,repository:ReturnType<typeof createIngestionRepository>,deadlineAt?:number) {
 requireIngestionManager(actor);if(message.organization_id!==actor.organizationId)throw new WinnrApiError(403,'forbidden','Foreign ingestion message')
 const body=await provider.body(uid,message.to_email)
 if(body.uid!==uid||body.mailbox.toLowerCase()!==message.to_email)throw new WinnrApiError(409,'conflict','Provider body identity mismatch')
 return deadlineAt===undefined
  ? repository.saveBody(actor.userId,actor.organizationId,message.id,uid,body.body,isDeterministicOptOut(body.body),message.connection_id,message.connection_version)
  : repository.saveBody(actor.userId,actor.organizationId,message.id,uid,body.body,isDeterministicOptOut(body.body),message.connection_id,message.connection_version,deadlineAt)
}
export const ingestionSyncInput=z.object({expectedConnectionId:z.uuid(),expectedConnectionVersion:z.number().int().positive(),mailboxId:z.string().min(1).max(200),cursor:z.string().max(4000).optional()}).strict()
export async function syncIngestion(actor:WinnrAuthContext,raw:unknown,deps:IngestionServiceDeps=createIngestionDeps()) {
 requireIngestionManager(actor);const input=ingestionSyncInput.parse(raw);const found=await deps.connections.getConnectionWithToken(actor.organizationId)
 if(!found||found.connection.id!==input.expectedConnectionId||found.connection.version!==input.expectedConnectionVersion)throw new WinnrApiError(409,'stale_connection','Connection changed')
 const config=await deps.repository.configuration(actor.organizationId,found.connection.id,found.connection.version);const endpoint=config?.configured?await deps.repository.endpoint(config.endpointId):null
 if(!endpoint)throw new WinnrApiError(409,'conflict','Associate a verified Winnr webhook first')
 const mailboxes=await deps.mailboxes.status(actor.organizationId,found.connection.id,found.connection.version);const mailbox=mailboxes.find(row=>row.providerMailboxId===input.mailboxId)
 if(!mailbox)throw new WinnrApiError(403,'forbidden','Mailbox is not owned by this connection')
 const provider=deps.provider(found.token);const page=await provider.list(mailbox.email,input.cursor)
 if(page.pagination.has_more&&(!page.pagination.cursor||page.pagination.cursor===input.cursor))throw new WinnrApiError(502,'provider_error','Provider pagination incomplete')
 for(const row of page.data) {
  if(row.mailbox.toLowerCase()!==mailbox.email.toLowerCase())throw new WinnrApiError(409,'conflict','Foreign provider mailbox')
  const sender=parseSingleInboundAddress(row.from_email??row.from)
  const event=parseWinnrInboundEvent({id:`evt_sync_${createHash('sha256').update(`${found.connection.id}:${found.connection.version}:${mailbox.accountId}:${row.message_id}:${row.in_reply_to??row.references??''}`).digest('hex')}`,object:'event',type:'email.received',api_version:'2026-08',created:row.received_at,account_id:found.connection.providerAccountId,data:{mailbox:mailbox.email.toLowerCase(),from:sender,message_id:row.message_id,subject:row.subject??'',received_at:row.received_at,...(row.in_reply_to?{in_reply_to:row.in_reply_to}:{}),...(row.references?{references:row.references}:{})}})
  await deps.repository.persist(endpoint,event,createHash('sha256').update(JSON.stringify(event)).digest('hex'),'sync')
 }
 let hydrated=0;let bodyUnavailable=0
 const pending=await deps.repository.pending(actor.organizationId,found.connection.id,found.connection.version,input.mailboxId,page.data.map(row=>row.message_id))
 for(const message of pending) await deps.repository.correlate(actor.organizationId,message.id)
 for (const message of pending.filter(item => item.body_status === 'pending' && page.data.some(row => row.message_id === item.message_id)).slice(0,3)) {
  const row = page.data.find(item => item.message_id === message.message_id && item.mailbox.toLowerCase() === message.to_email)
  if (!row) { bodyUnavailable++; continue }
  try {
   await reconcileProviderMapping(endpoint, message, provider, deps.repository)
   await hydrateIngestedMessage(actor, message, row.uid, provider, deps.repository)
   hydrated++
  } catch { bodyUnavailable++ }
 }
 const bodyPending=await deps.repository.pendingCount(actor.organizationId,found.connection.providerAccountId,mailbox.accountId)
 return{saved:page.data.length,bodyPending,hydrated,bodyUnavailable,nextCursor:page.pagination.has_more?page.pagination.cursor:null,bodyReady:bodyUnavailable===0&&bodyPending===0}
}

async function reconcileProviderMapping(endpoint: IngestionEndpoint, message: IngestedMessage, provider: WinnrInboundProvider, repository: ReturnType<typeof createIngestionRepository>, deadlineAt?: number) {
 if (!message.in_reply_to) return
 let mappings: Awaited<ReturnType<WinnrInboundProvider['mappings']>>
 try { mappings = await provider.mappings(message.in_reply_to) } catch { return } // Missing/rolling-out mapping does not block body retrieval.
 for (const map of mappings) {
  if (deadlineReached(deadlineAt)) return
  if (map.sender.toLowerCase() !== message.to_email || map.recipient.toLowerCase() !== message.from_email) continue
  const event = parseWinnrInboundEvent({ id: `evt_lookup_${createHash('sha256').update(`${endpoint.connectionId}:${map.provider_message_id}:${map.recipient}`).digest('hex')}`, object: 'event', type: 'message.relayed', api_version: '2026-08', created: map.relayed_at, account_id: endpoint.providerAccountId, data: map })
  await repository.persist(endpoint, event, createHash('sha256').update(JSON.stringify(event)).digest('hex'), 'lookup', deadlineAt)
 }
}
/** Consumer port for winnr.ingestion.body. Caller owns021 claim/ack fencing;
 * this read-only provider work is repeatable, SQL body persistence is idempotent.
 * `deadlineAt` is the absolute request deadline; provider reads and RPCs are
 * bounded by the remaining budget and the loop stops making further mutations
 * once it is reached.
 */
export async function processWinnrIngestionReceipt(actor: WinnrAuthContext, receiptId: string, deps: IngestionServiceDeps = createIngestionDeps(), deadlineAt?: number) {
 requireIngestionManager(actor)
 let work = await deps.repository.messageForReceipt(actor.organizationId, z.uuid().parse(receiptId), deadlineAt)
 if (!work) throw new WinnrApiError(404, 'bad_request', 'Ingestion receipt not found')
 const found = await deps.connections.getConnectionWithToken(actor.organizationId)
 if (!found || found.connection.providerAccountId !== work.provider_account_id) throw new WinnrApiError(409, 'stale_connection', 'Connection changed')
 const bindings=await deps.mailboxes.status(actor.organizationId,found.connection.id,found.connection.version)
 const binding=bindings.find(row=>row.accountId===work?.account_id&&row.email.toLowerCase()===work?.to_email)
 if(!binding)throw new WinnrApiError(409,'stale_connection','Mailbox association changed')
 const config = await deps.repository.configuration(actor.organizationId, found.connection.id, found.connection.version, deadlineAt)
 const endpoint = config?.configured ? await deps.repository.endpoint(config.endpointId, deadlineAt) : null
 if (!endpoint) throw new WinnrApiError(409, 'conflict', 'Webhook not configured')
 if (deadlineReached(deadlineAt)) throw new WinnrApiError(503, 'provider_error', 'Provider deadline exceeded')
 const provider = deps.provider(found.token, undefined, deadlineAt)
 await reconcileProviderMapping(endpoint, work, provider, deps.repository, deadlineAt)
 await deps.repository.correlate(actor.organizationId, work.id, deadlineAt)
 if (work.body_status === 'ready' && work.connection_id===found.connection.id && work.connection_version===found.connection.version) return { bodyReady: true }
 let cursor: string | undefined
 const cursors = new Set<string>()
 for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
  if (deadlineReached(deadlineAt)) throw new WinnrApiError(503, 'provider_error', 'Provider deadline exceeded')
  const page = await provider.list(work.to_email, cursor)
  const expected=work
  const rows = page.data.filter(row => row.message_id === expected.message_id && row.mailbox.toLowerCase() === expected.to_email)
  if (rows.length > 1) throw new WinnrApiError(409, 'conflict', 'Ambiguous provider message')
  if (rows[0]) {
   const row=rows[0]
   const event=parseWinnrInboundEvent({id:`evt_recovery_${createHash('sha256').update(`${found.connection.id}:${found.connection.version}:${binding.accountId}:${row.message_id}:${row.in_reply_to??row.references??''}`).digest('hex')}`,object:'event',type:'email.received',api_version:'2026-08',created:row.received_at,account_id:found.connection.providerAccountId,data:{mailbox:row.mailbox,from:parseSingleInboundAddress(row.from_email??row.from),message_id:row.message_id,subject:row.subject??'',received_at:row.received_at,...(row.in_reply_to?{in_reply_to:row.in_reply_to}:{}),...(row.references?{references:row.references}:{})}})
   await deps.repository.persist(endpoint,event,createHash('sha256').update(JSON.stringify(event)).digest('hex'),'sync',deadlineAt)
   work=await deps.repository.messageForReceipt(actor.organizationId,receiptId,deadlineAt)
   if(!work||work.connection_id!==found.connection.id||work.connection_version!==found.connection.version)throw new WinnrApiError(409,'stale_connection','Mailbox recovery failed')
   await hydrateIngestedMessage(actor, work, row.uid, provider, deps.repository, deadlineAt); return { bodyReady: true }
  }
  if (!page.pagination.has_more) break
  const next = page.pagination.cursor
  if (!next || cursors.has(next)) throw new WinnrApiError(502, 'provider_error', 'Incomplete provider pagination')
  cursors.add(next); cursor = next
 }
 return { bodyReady: false, reason: 'provider_message_unavailable' }
}
