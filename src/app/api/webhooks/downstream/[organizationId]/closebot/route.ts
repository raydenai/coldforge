export const maxDuration = 30

import { createHash } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { decrypt } from '@/lib/encryption'
import { createDownstreamRepository } from '@/lib/outreach/downstream/database'
import { extractInboundToken, readBoundedRequestBody, verifySharedToken } from '@/lib/outreach/downstream/providers'

const proposalSchema = z.record(z.string(), z.unknown())

const bodySchema = z
  .object({
    contactId: z.string().uuid().optional(),
    leadId: z.string().uuid().optional(),
    messageId: z.string().min(1).max(200).optional(),
    body: z.string().max(20000).optional(),
    state: z.record(z.string(), z.unknown()).optional(),
    proposal: proposalSchema.optional(),
    qualification: z
      .object({
        criteriaRevision: z.number().int().positive(),
        criteria: z.record(z.string(), z.unknown()),
        outcome: z.enum(['qualified', 'disqualified', 'unknown']),
        evidence: z.string().min(1).max(4000),
        campaignId: z.string().uuid().nullable().optional(),
        threadId: z.string().uuid().nullable().optional(),
        sourceDecisionId: z.string().uuid().nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .passthrough()

/**
 * Authenticated CloseBot custom-source callback. The shared token and the
 * tenant-scoped source binding are verified before anything is recorded; a
 * proposal is stored, and a qualification is only persisted when the callback
 * carries an explicit criteria/outcome/evidence record. The callback can never
 * send email or authorize a call.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ organizationId: string }> }) {
  const organizationId = z.uuid().parse((await params).organizationId)
  // Capture the bounded raw body before any auth or parsing.
  const rawBody = await readBoundedRequestBody(request)
  if (rawBody === null) {
    return NextResponse.json({ error: { code: 'bad_request', message: 'Request body is too large' } }, { status: 413 })
  }
  const repository = createDownstreamRepository()
  const secret = await repository.connectionSecret(organizationId, 'closebot')
  if (!secret.configured || !secret.credentialCiphertext) {
    return NextResponse.json({ error: { code: 'service_unavailable', message: 'CloseBot is not configured for this organization' } }, { status: 503 })
  }
  const config = secret.config ?? {}
  let expectedToken = ''
  try {
    expectedToken = extractInboundToken(decrypt(secret.credentialCiphertext))
  } catch {
    expectedToken = ''
  }
  const headerName = typeof config.inboundTokenHeader === 'string' ? config.inboundTokenHeader.toLowerCase() : 'x-closebot-token'
  if (!expectedToken || !verifySharedToken(request.headers.get(headerName), expectedToken)) {
    return NextResponse.json({ error: { code: 'unauthenticated', message: 'Invalid callback token' } }, { status: 401 })
  }
  let parsed: z.infer<typeof bodySchema>
  try {
    parsed = bodySchema.parse(JSON.parse(rawBody))
  } catch {
    return NextResponse.json({ error: { code: 'bad_request', message: 'Invalid webhook body' } }, { status: 400 })
  }
  const leadId = parsed.leadId ?? parsed.contactId
  if (!leadId) {
    return NextResponse.json({ error: { code: 'bad_request', message: 'A lead binding is required' } }, { status: 422 })
  }
  const sourceId = typeof config.sourceId === 'string' ? config.sourceId : ''
  const fingerprint = createHash('sha256').update(rawBody).digest('hex')
  const bridge = { leadId, sourceId, threadId: parsed.qualification?.threadId ?? null, externalMessageId: parsed.messageId ?? null, payloadFingerprint: fingerprint, proposal: parsed.proposal ?? parsed }
  let recorded: Record<string, unknown>
  try {
    if (parsed.qualification) {
      const q = parsed.qualification
      recorded = await repository.effect(organizationId, 'recordQualifiedBridge', {
        ...bridge,
        qualification: { leadId, campaignId: q.campaignId ?? null, threadId: q.threadId ?? null, criteriaRevision: q.criteriaRevision, criteria: q.criteria, outcome: q.outcome, evidence: q.evidence, attributedSource: 'closebot.callback', sourceDecisionId: q.sourceDecisionId ?? null, sourceEventKey: parsed.messageId ?? fingerprint, payloadFingerprint: fingerprint },
      }, Date.now() + 10_000)
    } else {
      recorded = await repository.recordInboundBridge(organizationId, bridge, Date.now() + 10_000)
    }
  } catch {
    return NextResponse.json({ error: { code: 'conflict', message: 'The canonical bridge and qualification were not recorded' } }, { status: 409 })
  }
  const qualificationId = typeof recorded.qualificationId === 'string' ? recorded.qualificationId : null
  const qualificationDuplicate = recorded.qualificationDuplicate === true

  return NextResponse.json({ recorded: true, duplicate: recorded.result === 'duplicate', qualificationId, qualificationDuplicate })
}
