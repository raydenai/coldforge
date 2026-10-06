export const maxDuration = 30

import { createHash } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createDownstreamRepository } from '@/lib/outreach/downstream/database'
import { readBoundedRequestBody, verifyGhlSignature } from '@/lib/outreach/downstream/providers'

/**
 * GHL appointment webhook. The Ed25519 signature is verified against the
 * official published public key (never a tenant-supplied key) over the bounded
 * raw body. An event only changes a booking when the immutable location id and
 * provider appointment id both match a stored reservation; anything else is
 * recorded but never marked booked.
 */
const appointmentSchema = z
  .object({
    id: z.string().min(1).max(200).optional(),
    locationId: z.string().min(1).max(200).optional(),
    startTime: z.string().optional(),
    endTime: z.string().optional(),
  })
  .passthrough()

const bodySchema = z
  .object({
    type: z.string().min(1).max(100).optional(),
    event: z.string().min(1).max(100).optional(),
    locationId: z.string().min(1).max(200).optional(),
    appointmentId: z.string().min(1).max(200).optional(),
    startTime: z.string().optional(),
    endTime: z.string().optional(),
    appointment: appointmentSchema.optional(),
  })
  .passthrough()

function normalizedStatus(eventType: string): 'scheduled' | 'rescheduled' | 'cancelled' | null {
  const value = eventType.toLowerCase()
  if (value.includes('cancel') || value.includes('delete')) return 'cancelled'
  if (value.includes('resched')) return 'rescheduled'
  if (value.includes('create') || value.includes('update')) return 'scheduled'
  return null
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ organizationId: string }> }) {
  const organizationId = z.uuid().parse((await params).organizationId)
  const rawBody = await readBoundedRequestBody(request)
  if (rawBody === null) {
    return NextResponse.json({ error: { code: 'bad_request', message: 'Request body is too large' } }, { status: 413 })
  }
  const repository = createDownstreamRepository()
  const secret = await repository.connectionSecret(organizationId, 'ghl')
  if (!secret.configured) {
    return NextResponse.json({ error: { code: 'service_unavailable', message: 'GoHighLevel is not configured for this organization' } }, { status: 503 })
  }
  if (!verifyGhlSignature(rawBody, request.headers.get('x-ghl-signature'))) {
    return NextResponse.json({ error: { code: 'unauthenticated', message: 'Invalid signature' } }, { status: 401 })
  }
  let parsed: z.infer<typeof bodySchema>
  try {
    parsed = bodySchema.parse(JSON.parse(rawBody))
  } catch {
    return NextResponse.json({ error: { code: 'bad_request', message: 'Invalid webhook body' } }, { status: 400 })
  }
  const fingerprint = createHash('sha256').update(rawBody).digest('hex')
  const eventType = parsed.type ?? parsed.event ?? ''
  const appointment = parsed.appointment ?? {}
  const appointmentId = parsed.appointmentId ?? appointment.id ?? null
  const locationId = parsed.locationId ?? appointment.locationId ?? null
  const status = normalizedStatus(eventType)
  const eventKey = `${eventType || 'unrecognized'}:${fingerprint}`
  const result = await repository.recordWebhookEvent(
    organizationId,
    {
      provider: 'ghl',
      eventKey,
      providerAppointmentId: appointmentId,
      locationId,
      ...(status ? { status } : {}),
      ...(parsed.startTime ?? appointment.startTime ? { startsAt: parsed.startTime ?? appointment.startTime } : {}),
      ...(parsed.endTime ?? appointment.endTime ? { endsAt: parsed.endTime ?? appointment.endTime } : {}),
      payloadFingerprint: fingerprint,
    },
    Date.now() + 10_000,
  )
  return NextResponse.json({ accepted: true, matched: result.result === 'matched' }, { status: 202 })
}
