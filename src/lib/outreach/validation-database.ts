/**
 * Narrow service-role repository for lead validation.
 *
 * Every mutation goes through a SECURITY DEFINER RPC that independently
 * re-checks the actor's membership, the organization, and the lead's current
 * email. Reads are organization-scoped and return provenance so a caller can
 * tell a measured verdict from an explicit-but-unmeasured `unknown`.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import type { ValidationStatus, VerificationLevel, ValidationSource } from './validation'

export class ValidationRepositoryError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'ValidationRepositoryError'
  }
}

export interface ValidationEvidence {
  leadId: string
  validationStatus: ValidationStatus
  substatus: string | null
  verificationLevel: VerificationLevel
  source: string
  reference: string | null
  checkedAt: string | null
  operationId: string | null
  attested: boolean
}

export interface ValidationLead {
  id: string
  email: string
  status: string | null
  validationStatus: ValidationStatus | null
  provenance: ValidationEvidence | null
  /** True only for a provider receipt or an owner-attested import. */
  measured: boolean
}

export interface ValidationSummary {
  total: number
  measured: number
  explicitUnknown: number
  unchecked: number
  valid: number
  invalid: number
  risky: number
}

export interface OperationResult {
  operationId: string
  email: string
  state: 'reserved' | 'completed' | 'held_unknown' | 'failed'
  validationStatus: ValidationStatus | null
  outcome?: string | null
  replayed: boolean
}

/** An unresolved attempt that the UI must resume rather than re-pay for. */
export interface OutstandingOperation {
  operationId: string
  leadId: string
  email: string
  state: 'reserved' | 'held_unknown'
  validationStatus: ValidationStatus | null
}

interface RpcResponse {
  data: unknown
  error: { message?: string; code?: string } | null
}

function asRpcResult(value: unknown): OperationResult {
  const row = (value ?? {}) as Record<string, unknown>
  return {
    operationId: String(row.operationId ?? ''),
    email: String(row.email ?? ''),
    state: (row.state as OperationResult['state']) ?? 'failed',
    validationStatus: (row.validationStatus as ValidationStatus | null) ?? null,
    outcome: (row.outcome as string | null) ?? null,
    replayed: row.replayed === true,
  }
}

function assertOk(response: RpcResponse, fallback: string): unknown {
  if (response.error) {
    const raw = response.error.message ?? ''
    const code = raw.includes('lead_validation:') ? raw.slice(raw.indexOf('lead_validation:')) : fallback
    throw new ValidationRepositoryError(code.split('\n')[0]!.trim())
  }
  return response.data
}

export function createValidationRepository() {
  // The generated database types do not yet cover these additive tables, so we
  // use the untyped surface deliberately and keep every row shape local.
  const db = createAdminClient() as unknown as SupabaseClient

  return {
    async listLeads(organizationId: string, limit = 200): Promise<ValidationLead[]> {
      const { data: leads, error } = await db
        .from('leads')
        .select('id,email,status,validation_status')
        .eq('organization_id', organizationId)
        .order('created_at', { ascending: false })
        .limit(Math.min(Math.max(limit, 1), 500))
      if (error) throw new ValidationRepositoryError('lead_validation:read_failed')

      const leadRows = (leads ?? []) as Array<Record<string, unknown>>
      const { data: evidence, error: evidenceError } = await db
        .from('lead_validation_evidence')
        .select('lead_id,validation_status,substatus,verification_level,source,reference,checked_at,operation_id,attested')
        .eq('organization_id', organizationId)
      // A failed evidence read must surface as unavailable: silently treating
      // it as "no evidence" would relabel a measured verdict as legacy.
      if (evidenceError) throw new ValidationRepositoryError('lead_validation:read_failed')
      const evidenceByLead = new Map<string, ValidationEvidence>()
      for (const row of (evidence ?? []) as Array<Record<string, unknown>>) {
        const leadId = String(row.lead_id)
        evidenceByLead.set(leadId, {
          leadId,
          validationStatus: row.validation_status as ValidationStatus,
          substatus: (row.substatus as string | null) ?? null,
          verificationLevel: row.verification_level as VerificationLevel,
          source: String(row.source ?? ''),
          reference: (row.reference as string | null) ?? null,
          checkedAt: (row.checked_at as string | null) ?? null,
          operationId: (row.operation_id as string | null) ?? null,
          attested: row.attested === true,
        })
      }

      return leadRows.map((row) => {
        const id = String(row.id)
        const evidence = evidenceByLead.get(id) ?? null
        const measured = evidence?.verificationLevel === 'verified_provider' || evidence?.verificationLevel === 'verified_import'
        return {
          id,
          email: String(row.email ?? ''),
          status: (row.status as string | null) ?? null,
          // A historical `validation_status` with no evidence row stays
          // visible but is labeled legacy/unverified, never measured.
          validationStatus: (row.validation_status as ValidationStatus | null) ?? null,
          provenance: evidence,
          measured,
        }
      })
    },

    summarize(leads: ValidationLead[]): ValidationSummary {
      return {
        total: leads.length,
        measured: leads.filter((lead) => lead.measured).length,
        explicitUnknown: leads.filter((lead) => lead.validationStatus === 'unknown').length,
        unchecked: leads.filter((lead) => lead.validationStatus === null).length,
        valid: leads.filter((lead) => lead.validationStatus === 'valid').length,
        invalid: leads.filter((lead) => lead.validationStatus === 'invalid').length,
        risky: leads.filter((lead) => lead.validationStatus === 'risky').length,
      }
    },

    async listOutstandingOperations(organizationId: string): Promise<OutstandingOperation[]> {
      const { data, error } = await db
        .from('lead_validation_operations')
        .select('id,lead_id,email,state,validation_status,created_at')
        .eq('organization_id', organizationId)
        .in('state', ['reserved', 'held_unknown'])
        .order('created_at', { ascending: false })
      if (error) throw new ValidationRepositoryError('lead_validation:read_failed')
      return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
        operationId: String(row.id),
        leadId: String(row.lead_id),
        email: String(row.email ?? ''),
        state: row.state as OutstandingOperation['state'],
        validationStatus: (row.validation_status as ValidationStatus | null) ?? null,
      }))
    },

    async reserveOperation(input: {
      operationId: string
      actorId: string
      organizationId: string
      leadId: string
      source: ValidationSource
    }): Promise<OperationResult> {
      const response = (await db.rpc('lead_validation_reserve_operation', {
        p_operation_id: input.operationId,
        p_actor: input.actorId,
        p_org: input.organizationId,
        p_lead: input.leadId,
        p_source: input.source,
      })) as RpcResponse
      return asRpcResult(assertOk(response, 'lead_validation:reserve_failed'))
    },

    async finalizeProvider(input: {
      operationId: string
      actorId: string
      organizationId: string
      leadId: string
      providerEmail: string | null
      providerStatus: string
      substatus: string | null
      reference: string | null
      checkedAt: string | null
    }): Promise<OperationResult> {
      const response = (await db.rpc('lead_validation_finalize_provider', {
        p_operation_id: input.operationId,
        p_actor: input.actorId,
        p_org: input.organizationId,
        p_lead: input.leadId,
        p_provider: 'zerobounce',
        p_provider_email: input.providerEmail,
        p_status: input.providerStatus,
        p_substatus: input.substatus,
        p_reference: input.reference,
        p_checked_at: input.checkedAt,
      })) as RpcResponse
      return asRpcResult(assertOk(response, 'lead_validation:finalize_failed'))
    },

    async importReport(input: {
      operationId: string
      actorId: string
      organizationId: string
      leadId: string
      status: ValidationStatus
      source: string
      reference: string
      reportedAt: string
      attested: boolean
    }): Promise<OperationResult> {
      const response = (await db.rpc('lead_validation_import_report', {
        p_operation_id: input.operationId,
        p_actor: input.actorId,
        p_org: input.organizationId,
        p_lead: input.leadId,
        p_status: input.status,
        p_source: input.source,
        p_reference: input.reference,
        p_reported_at: input.reportedAt,
        p_attested: input.attested,
      })) as RpcResponse
      return asRpcResult(assertOk(response, 'lead_validation:import_failed'))
    },
  }
}
