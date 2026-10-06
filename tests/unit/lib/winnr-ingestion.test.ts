import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { parseWinnrInboundEvent, receiveWinnrEvent } from '@/lib/outreach/ingestion'
const now = Date.now(); const timestamp = String(Math.floor(now / 1000)); const secret = 'whsec_synthetic'
const event = { id: 'evt_one', object: 'event', type: 'email.received', api_version: '2026-08', created: new Date(now).toISOString(), account_id: 'acct_own', data: { mailbox: 'sender@example.test', from: 'lead@example.test', message_id: '<reply@example.test>', subject: 'Reply' } }
const raw = Buffer.from(JSON.stringify(event))
const signature = createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex')
function deps() { return { endpoint: vi.fn(async () => ({ id: 'endpoint', organizationId: 'org', connectionId: 'conn', connectionVersion: 1, providerAccountId: 'acct_own', secret })), persist: vi.fn(async () => ({ duplicate: false, eventId: 'saved' })) } }
describe('signed durable Winnr receipt', () => {
 it('accepts rotation signatures and durably stores before acknowledgement', async () => {
  const d = deps(); expect(await receiveWinnrEvent('endpoint',raw,{timestamp,signature:`v1=bad,v1=${signature}`,eventId:event.id,eventType:event.type},d,now)).toEqual({duplicate:false,eventId:'saved'}); expect(d.persist).toHaveBeenCalledOnce()
 })
 it('rejects replay, account mismatch and inconsistent header identity without writes', async () => {
  for (const headers of [{timestamp:'1',signature:`v1=${signature}`,eventId:event.id,eventType:event.type},{timestamp,signature:`v1=${signature}`,eventId:'evt_other',eventType:event.type}]) { const d=deps(); await expect(receiveWinnrEvent('endpoint',raw,headers,d,now)).rejects.toThrow(); expect(d.persist).not.toHaveBeenCalled() }
  const d=deps(); d.endpoint.mockResolvedValue({id:'endpoint',organizationId:'org',connectionId:'conn',connectionVersion:1,providerAccountId:'acct_other',secret}); await expect(receiveWinnrEvent('endpoint',raw,{timestamp,signature:`v1=${signature}`,eventId:event.id,eventType:event.type},d,now)).rejects.toThrow(); expect(d.persist).not.toHaveBeenCalled()
 })
 it('propagates durability failure rather than acknowledging', async () => { const d=deps();d.persist.mockRejectedValue(new Error('storage'));await expect(receiveWinnrEvent('endpoint',raw,{timestamp,signature:`v1=${signature}`,eventId:event.id,eventType:event.type},d,now)).rejects.toThrow() })
 it('validates optional threading references and a single documented From address',()=>{
  expect(parseWinnrInboundEvent({...event,data:{...event.data,from:'Lead <lead@example.test>',references:'<older@example.test> <last@example.test>'}}).data).toMatchObject({from:'lead@example.test',in_reply_to:'<last@example.test>'})
  expect(()=>parseWinnrInboundEvent({...event,data:{...event.data,from:'one@example.test, two@example.test'}})).toThrow()
 })

})
