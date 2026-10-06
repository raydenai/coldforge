import { z } from 'zod'

/**
 * Trust-boundary schemas for verified SMTP reconciliation.
 *
 * The browser may only name one attempt and, optionally, the immutable
 * fingerprint it was shown. Outcome, proof, recipient, body and message
 * identity are never accepted from the client; they come from the persisted
 * 027 relay ledger inside the service-only SQL transaction.
 */
export const evidenceStatusSchema = z.enum(['available', 'missing', 'conflicting'])
export type EvidenceStatus = z.infer<typeof evidenceStatusSchema>

export const reconciliationRequestSchema = z
  .object({
    attemptId: z.uuid(),
    fingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/, 'Expected a lowercase sha-256 fingerprint')
      .optional(),
  })
  .strict()
export type ReconciliationRequest = z.infer<typeof reconciliationRequestSchema>

export const reconciliationQuerySchema = z
  .object({ attemptId: z.uuid().optional() })
  .strict()
export type ReconciliationQuery = z.infer<typeof reconciliationQuerySchema>

export const reconciliationKindSchema = z.enum(['campaign', 'reply'])
export type ReconciliationKind = z.infer<typeof reconciliationKindSchema>

export const reconciliationItemSchema = z.object({
  attemptId: z.uuid(),
  kind: reconciliationKindSchema,
  status: z.string().min(1).max(32),
  createdAt: z.string().min(1),
  authorizedAt: z.string().min(1).nullable().optional(),
  ageSeconds: z.number().int().nonnegative(),
  recipient: z.string().min(1),
  sender: z.string().min(1),
  campaignId: z.uuid().nullable(),
  threadId: z.uuid().nullable(),
  sourceReplyId: z.uuid().nullable(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  evidence: evidenceStatusSchema,
  providerMessageId: z.string().nullable().optional(),
})
export type ReconciliationItem = z.infer<typeof reconciliationItemSchema>

export const reconciliationCountsSchema = z.object({
  unconfirmed: z.number().int().nonnegative(),
  accepted: z.number().int().nonnegative(),
  held: z.number().int().nonnegative(),
  available: z.number().int().nonnegative(),
  conflicting: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
})
export type ReconciliationCounts = z.infer<typeof reconciliationCountsSchema>

export const reconciliationAuditSchema = z.object({
  auditId: z.uuid(),
  attemptId: z.uuid(),
  kind: reconciliationKindSchema,
  reconciledAt: z.string().min(1),
  reconciledBy: z.uuid(),
  providerMessageId: z.string().min(1),
  recipient: z.string().min(1),
  sourceReceiptId: z.uuid(),
  sourceReceiptFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
})
export type ReconciliationAudit = z.infer<typeof reconciliationAuditSchema>

export const reconciliationListSchema = z.object({
  items: z.array(reconciliationItemSchema),
  counts: reconciliationCountsSchema,
  recent: z.array(reconciliationAuditSchema),
  generatedAt: z.string().min(1),
})
export type ReconciliationList = z.infer<typeof reconciliationListSchema>

export const reconciliationStatusSchema = z.object({
  attemptId: z.uuid(),
  kind: reconciliationKindSchema,
  status: z.string().min(1).max(32),
  canReconcile: z.boolean(),
  reason: z.string().nullable(),
  evidence: evidenceStatusSchema,
  ageSeconds: z.number().int().nonnegative(),
  recipient: z.string().min(1),
  sender: z.string().min(1),
  campaignId: z.uuid().nullable(),
  threadId: z.uuid().nullable(),
  canonicalThreadId: z.uuid().nullable(),
  sourceReplyId: z.uuid().nullable(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  auditId: z.uuid().nullable(),
})
export type ReconciliationStatus = z.infer<typeof reconciliationStatusSchema>

export const reconciliationOutcomeSchema = z.object({
  status: z.enum(['accepted', 'held']),
  alreadyAccepted: z.boolean().optional(),
  reason: z.string().optional(),
  attemptId: z.uuid(),
  kind: reconciliationKindSchema.optional(),
  previousStatus: z.string().optional(),
  evidence: evidenceStatusSchema.optional(),
  auditId: z.uuid().nullish(),
  eventId: z.uuid().optional(),
  sourceReceiptId: z.uuid().optional(),
  providerMessageId: z.string().optional(),
  recipient: z.string().optional(),
})
export type ReconciliationOutcome = z.infer<typeof reconciliationOutcomeSchema>
