export const maxDuration = 30

import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { assertSameOrigin, parseJsonRequest, resolveAuthContext, winnrErrorResponse } from '@/app/api/winnr/_shared'
import {
  cancelAppointmentInputSchema,
  checkConnectionInputSchema,
  listSlotsInputSchema,
  qualifyInputSchema,
  recordEligibilityInputSchema,
  requestAppointmentInputSchema,
  rescheduleAppointmentInputSchema,
  reviewBridgeInputSchema,
  revokeEligibilityInputSchema,
  saveConnectionInputSchema,
  setEnabledInputSchema,
} from '@/lib/outreach/downstream/core'
import { createDownstreamWorkerDeps } from '@/lib/outreach/downstream/runtime'
import { initiateRequestedCallback } from '@/lib/outreach/downstream/scheduler'
import {
  cancelAppointment,
  checkConnection,
  createDownstreamServiceDeps,
  listCalendars,
  listSlots,
  readDownstream,
  requireDownstreamManager,
  recordEligibility,
  recordQualification,
  requestAppointment,
  rescheduleAppointment,
  reviewBridge,
  revokeEligibility,
  saveConnection,
  setConnectionEnabled,
} from '@/lib/outreach/downstream/service'

const REQUEST_BUDGET_MS = 29_000

const requestSchema = z.discriminatedUnion('action', [
  saveConnectionInputSchema.extend({ action: z.literal('saveConnection') }),
  setEnabledInputSchema.extend({ action: z.literal('setEnabled') }),
  checkConnectionInputSchema.extend({ action: z.literal('check') }),
  recordEligibilityInputSchema.extend({ action: z.literal('recordEligibility') }),
  revokeEligibilityInputSchema.extend({ action: z.literal('revokeEligibility') }),
  qualifyInputSchema.extend({ action: z.literal('qualify') }),
  reviewBridgeInputSchema.extend({ action: z.literal('reviewBridge') }),
  listSlotsInputSchema.extend({ action: z.literal('listSlots') }),
  requestAppointmentInputSchema.extend({ action: z.literal('requestAppointment') }),
  rescheduleAppointmentInputSchema.extend({ action: z.literal('rescheduleAppointment') }),
  cancelAppointmentInputSchema.extend({ action: z.literal('cancelAppointment') }),
  z.object({ action: z.literal('listCalendars') }).strict(),
  z.object({ action: z.literal('initiateCallback'), eligibilityId: z.string().uuid() }).strict(),
])

export async function GET() {
  const deadlineAt = Date.now() + REQUEST_BUDGET_MS
  try {
    const actor = await resolveAuthContext()
    requireDownstreamManager(actor)
    return NextResponse.json(await readDownstream(actor, undefined, deadlineAt))
  } catch (error) {
    return winnrErrorResponse(error)
  }
}

export async function POST(request: NextRequest) {
  const deadlineAt = Date.now() + REQUEST_BUDGET_MS
  try {
    const actor = await resolveAuthContext()
    assertSameOrigin(request)
    requireDownstreamManager(actor)
    const input = requestSchema.parse(await parseJsonRequest(request))
    const deps = createDownstreamServiceDeps()
    switch (input.action) {
      case 'saveConnection':
        return NextResponse.json(await saveConnection(actor, input, deps, deadlineAt))
      case 'setEnabled':
        return NextResponse.json(await setConnectionEnabled(actor, input, deps, deadlineAt))
      case 'check':
        return NextResponse.json(await checkConnection(actor, input, deps, deadlineAt))
      case 'recordEligibility':
        return NextResponse.json(await recordEligibility(actor, input, deps, deadlineAt))
      case 'revokeEligibility':
        return NextResponse.json(await revokeEligibility(actor, input, deps, deadlineAt))
      case 'qualify':
        return NextResponse.json(await recordQualification(actor, input, deps, deadlineAt))
      case 'reviewBridge':
        return NextResponse.json(await reviewBridge(actor, input, deps, deadlineAt))
      case 'listCalendars':
        return NextResponse.json(await listCalendars(actor, deps, deadlineAt))
      case 'listSlots':
        return NextResponse.json(await listSlots(actor, input, deps, deadlineAt))
      case 'requestAppointment': {
        const result = await requestAppointment(actor, input, deps, deadlineAt)
        return NextResponse.json(result, { status: result.allowed ? 201 : 409 })
      }
      case 'rescheduleAppointment': {
        const result = await rescheduleAppointment(actor, input, deps, deadlineAt)
        return NextResponse.json(result, { status: result.allowed ? 200 : 409 })
      }
      case 'cancelAppointment': {
        const result = await cancelAppointment(actor, input, deps, deadlineAt)
        return NextResponse.json(result, { status: result.allowed ? 200 : 409 })
      }
      case 'initiateCallback': {
        const result = await initiateRequestedCallback(actor, input.eligibilityId, createDownstreamWorkerDeps(), deadlineAt)
        return NextResponse.json(result, { status: result.allowed ? 200 : 409 })
      }
    }
  } catch (error) {
    return winnrErrorResponse(error)
  }
}
