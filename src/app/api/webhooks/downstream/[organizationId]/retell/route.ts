export const maxDuration = 30

import { createHash } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { decrypt } from '@/lib/encryption'
import { createDownstreamRepository } from '@/lib/outreach/downstream/database'
import { extractCredentialSecret, readBoundedRequestBody, verifyRetellSignature } from '@/lib/outreach/downstream/providers'

const RETELL_STATUS: Record<string, string> = {
  call_started: 'initiated',
  call_ended: 'completed',
  call_analyzed: 'completed',
  call_failed: 'failed',
}

const bodySchema = z.object({
  event: z.string().min(1).max(100),
  call: z
    .object({
      call_id: z.string().min(1).max(200),
      call_analysis: z.record(z.string(), z.unknown()).optional(),
    })
    .passthrough(),
})

export async function POST(request: NextRequest, { params }: { params: Promise<{ organizationId: string }> }) {
  const organizationId = z.uuid().parse((await params).organizationId)
  const rawBody = await readBoundedRequestBody(request)
  if (rawBody === null) {
    return NextResponse.json({ error: { code: 'bad_request', message: 'Request body is too large' } }, { status: 413 })
  }
  const repository = createDownstreamRepository()
  const secret = await repository.connectionSecret(organizationId, 'retell')
  if (!secret.configured || !secret.credentialCiphertext) {
    return NextResponse.json({ error: { code: 'service_unavailable', message: 'Retell is not configured for this organization' } }, { status: 503 })
  }
  let apiKey = ''
  try {
    apiKey = extractCredentialSecret(decrypt(secret.credentialCiphertext))
  } catch {
    apiKey = ''
  }
  if (!apiKey) {
    return NextResponse.json({ error: { code: 'service_unavailable', message: 'Retell credential is unreadable' } }, { status: 503 })
  }
  if (!verifyRetellSignature(rawBody, request.headers.get('x-retell-signature'), apiKey)) {
    return NextResponse.json({ error: { code: 'unauthenticated', message: 'Invalid signature' } }, { status: 401 })
  }
  let parsed: z.infer<typeof bodySchema>
  try {
    parsed = bodySchema.parse(JSON.parse(rawBody))
  } catch {
    return NextResponse.json({ error: { code: 'bad_request', message: 'Invalid webhook body' } }, { status: 400 })
  }
  const callId = parsed.call.call_id
  const status = RETELL_STATUS[parsed.event]
  const summary = parsed.call.call_analysis ?? undefined
  const eventKey = `${parsed.event}:${callId}`
  await repository.recordWebhookEvent(
    organizationId,
    {
      provider: 'retell',
      eventKey,
      providerCallId: callId,
      payloadFingerprint: createHash('sha256').update(rawBody).digest('hex'),
      ...(status ? { status } : {}),
      ...(summary ? { summary } : {}),
    },
    Date.now() + 10_000,
  )
  return new NextResponse(null, { status: 204 })
}
