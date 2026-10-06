import { describe,it,expect,vi } from 'vitest'
import type { DispatchDeps } from '@/lib/outreach/dispatch'
import { renderReply,replyInputSchema,executePreparedReply,prepareReply } from '@/lib/outreach/replies'
describe('immutable reply content',()=>{
 it('refuses caller recipient/org/message ID fields',()=>{expect(replyInputSchema.safeParse({message:'Hello',sourceReplyId:'11111111-1111-4111-8111-111111111111',controlRevision:1,to:'foreign@example.test'}).success).toBe(false)})
 it('renders approved identity and literal escaped human content',()=>{
  process.env.ENCRYPTION_SECRET='synthetic-fixture-only'
  const result=renderReply({threadId:'11111111-1111-4111-8111-111111111111',sourceReplyId:'22222222-2222-4222-8222-222222222222',controlRevision:1,recipient:'lead@example.test',leadId:'33333333-3333-4333-8333-333333333333',subject:'Question',inReplyTo:'<incoming@example.test>',configuration:{campaign_id:'44444444-4444-4444-8444-444444444444',organization_id:'55555555-5555-4555-8555-555555555555',sender_name:'Approved',sender_company:'Company',business_address:'Provided address',sender_email:'sender@example.test',mailbox_id:'provider',mailbox_daily_limit:5,connection_id:'66666666-6666-4666-8666-666666666666',connection_version:1,killed:false}},'<script>no template {{name}}</script>','https://fixture.example')
  expect(result.to).toBe('lead@example.test');expect(result.inReplyTo).toBe('<incoming@example.test>');expect(result.html).toContain('&lt;script&gt;');expect(result.text).toContain('{{name}}');expect(result.text).toContain('Provided address');expect(result.headers?.['List-Unsubscribe']).toContain('/unsubscribe?token=')
 })
})

describe('reply acceptance and unknown outcome boundary',()=>{
 it('lost receipt persistence never resubmits an accepted SMTP effect',async()=>{
 process.env.ENCRYPTION_SECRET='synthetic-fixture-only'
 const context={threadId:'11111111-1111-4111-8111-111111111111',sourceReplyId:'22222222-2222-4222-8222-222222222222',controlRevision:1,recipient:'lead@example.test',leadId:'33333333-3333-4333-8333-333333333333',subject:'Question',inReplyTo:'<incoming@example.test>',configuration:{campaign_id:'44444444-4444-4444-8444-444444444444',organization_id:'55555555-5555-4555-8555-555555555555',sender_name:'Approved',sender_company:'Company',business_address:'Provided address',sender_email:'sender@example.test',mailbox_id:'provider',mailbox_daily_limit:5,connection_id:'66666666-6666-4666-8666-666666666666',connection_version:1,killed:false}}
 const prepared=prepareReply(context,'Human reply','https://fixture.example'),send=vi.fn().mockResolvedValue({outcome:'accepted',messageId:prepared.message.messageId,recipient:prepared.message.to})
 const call=vi.fn().mockResolvedValueOnce({allowed:true,attempt:{id:context.threadId,claim_token:context.sourceReplyId}}).mockRejectedValueOnce(new Error('DB acknowledgement lost'))
 const deps:DispatchDeps={repository:{call},transport:{send},mailboxAvailable:async()=>true,appUrl:'https://fixture.example'}
 const result=await executePreparedReply(context.leadId,context.configuration.organization_id,prepared,'human',undefined,deps)
 expect(result.accepted).toBe(false);expect(result.code).toBe('receipt_persistence_failed');expect(result.attemptId).toBe(context.threadId);expect(send).toHaveBeenCalledTimes(1)
 })
})
