import { z } from 'zod'

/** The four bounded external phases, in fair round-robin order. */
export const OPERATIONS_PHASES = ['campaign', 'body', 'decision', 'reply'] as const
export type OperationsPhase = (typeof OPERATIONS_PHASES)[number]

export const phaseStatusSchema = z.enum(['idle', 'completed', 'held', 'blocked'])
export type PhaseStatus = z.infer<typeof phaseStatusSchema>

export interface PhaseOutcome {
  status: PhaseStatus
  reason?: string
  attemptId?: string
  decisionId?: string
  referenceId?: string
  referenceFingerprint?: string
  modelCalls: number
  smtpAttempts: number
}

export function isAttentionStatus(status: PhaseStatus): boolean {
  return status === 'held' || status === 'blocked'
}

export function isSuccessfulTick(status: PhaseStatus): boolean {
  return status === 'idle' || status === 'completed'
}

export const operationsControlSchema = z.object({
  revision: z.number().int().positive(),
  automationEnabled: z.boolean(),
  schedulerPaused: z.boolean(),
  masterStop: z.boolean(),
  enabledAt: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
})

export const operationsHeartbeatSchema = z.object({
  revision: z.number().int().nonnegative(),
  lastAttemptAt: z.string().nullable(),
  lastAttemptPhase: z.string().nullable(),
  lastAttemptStatus: z.string().nullable(),
  lastAttemptDetail: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  consecutiveFailures: z.number().int().nonnegative(),
})

export const operationsStatsSchema = z.object({
  attemptsAccepted: z.number().int().nonnegative(),
  attemptsUnknown: z.number().int().nonnegative(),
  attemptsReserved: z.number().int().nonnegative(),
  sendsAcceptedToday: z.number().int().nonnegative(),
  agentRunsUnknown: z.number().int().nonnegative(),
  bodyPending: z.number().int().nonnegative(),
  decisionsPending: z.number().int().nonnegative(),
})

export const operationsAttentionSchema = z.object({
  kind: z.string().min(1),
  referenceId: z.string().min(1),
  reason: z.string().nullable(),
  observedAt: z.string().nullable(),
  fingerprint: z.string().nullable(),
})

export const operationsRunSchema = z.object({
  id: z.string().min(1),
  phase: z.enum(OPERATIONS_PHASES),
  status: z.string().min(1),
  reason: z.string().nullable(),
  campaignId: z.string().nullable(),
  referenceId: z.string().nullable(),
  referenceFingerprint: z.string().nullable(),
  attemptId: z.string().nullable(),
  decisionId: z.string().nullable(),
  modelCalls: z.number().int().nonnegative(),
  smtpAttempts: z.number().int().nonnegative(),
  startedAt: z.string(),
  settledAt: z.string().nullable(),
})

export const operationsStatusSchema = z.object({
  control: operationsControlSchema,
  heartbeat: operationsHeartbeatSchema,
  stats: operationsStatsSchema,
  attention: z.array(operationsAttentionSchema),
  runs: z.array(operationsRunSchema),
})

export const readinessBlockerSchema = z.object({
  code: z.string().min(1),
  label: z.string().min(1),
  href: z.string().min(1),
})

export const operationsReadinessSchema = z.object({
  ready: z.boolean(),
  activeCampaigns: z.number().int().nonnegative(),
  configuredCampaigns: z.number().int().nonnegative(),
  blockers: z.array(readinessBlockerSchema),
})

export type OperationsControl = z.infer<typeof operationsControlSchema>
export type OperationsHeartbeat = z.infer<typeof operationsHeartbeatSchema>
export type OperationsStats = z.infer<typeof operationsStatsSchema>
export type OperationsAttention = z.infer<typeof operationsAttentionSchema>
export type OperationsRun = z.infer<typeof operationsRunSchema>
export type OperationsStatus = z.infer<typeof operationsStatusSchema>
export type OperationsReadiness = z.infer<typeof operationsReadinessSchema>

export const CONTROL_ACTIONS = [
  'enable',
  'disable',
  'pause',
  'resume',
  'stop',
  'resumeStop',
] as const
export type OperationsControlAction = (typeof CONTROL_ACTIONS)[number]

export interface OperationsControlResult {
  revision: number
  automationEnabled: boolean
  schedulerPaused: boolean
  masterStop: boolean
}

export interface OperationsSettlementInput {
  organizationId: string
  scopeKey: string
  leaseToken: string
  leaseExpiresAt: string
  status: PhaseStatus
  reason?: string
  attemptId?: string
  decisionId?: string
  referenceId?: string
  referenceFingerprint?: string
  modelCalls: number
  smtpAttempts: number
  /** Absolute epoch-ms request deadline; storage calls must not outlive it. */
  deadlineAt?: number
}

export interface OperationsClaim {
  result: 'claimed'
  runId: string
  leaseToken: string
  leaseExpiresAt: string
  organizationId: string
  actorId: string
  role: 'owner' | 'admin'
  phase: OperationsPhase
  campaignId: string | null
  scopeKey: string
}

export type OperationsClaimOutcome = OperationsClaim | { result: 'idle'; reason: string }

export interface OperationsRepository {
  claim(input: {
    leaseToken: string
    leaseSeconds: number
    organizationId?: string
    /** Absolute epoch-ms request deadline; the claim RPC must not outlive it. */
    deadlineAt?: number
  }): Promise<OperationsClaimOutcome>
  settle(input: OperationsSettlementInput): Promise<{ result: 'settled' | 'stale' | 'not_found' | 'invalid' }>
  read(actor: { userId: string; organizationId: string; role: string }, deadlineAt?: number): Promise<OperationsStatus>
  readiness(actor: { userId: string; organizationId: string; role: string }, deadlineAt?: number): Promise<OperationsReadiness>
  control(
    actor: { userId: string; organizationId: string; role: string },
    action: OperationsControlAction,
    expectedRevision: number,
    deadlineAt?: number,
  ): Promise<OperationsControlResult>
}

export interface TickResult {
  result: 'settled' | 'idle' | 'unsettled' | 'error'
  phase?: OperationsPhase
  organizationId?: string
  status?: PhaseStatus
  reason?: string
  modelCalls?: number
  smtpAttempts?: number
}
