import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { WinnrApiError } from '@/lib/winnr/server'
import { campaignFromRow, campaignRow, sequenceFromRow, sequenceRow, type CampaignRow, campaignStatus } from './core'

type Json = null | boolean | string | number | Json[] | { [key: string]: Json | undefined }
type Table<Row> = { Row: Row; Insert: Partial<Row>; Update: Partial<Row>; Relationships: [] }
type LeadRow = { id: string; organization_id: string | null; list_id: string | null; email: string; first_name: string | null; last_name: string | null; company: string | null; title: string | null; validation_status: string | null }
type EnrollmentRow = { id: string; campaign_id: string | null; lead_id: string | null; status: string | null; current_step: number | null; last_sent_at: string | null; next_send_at: string | null; created_at: string | null }
/** Exact existing columns plus the service-only RPC from migration 022. */
export interface CampaignCoreDatabase {
  public: {
    Tables: {
      campaigns: Table<Omit<CampaignRow, 'settings' | 'stats'> & { settings: Json; stats: Json }>
      campaign_sequences: Table<z.infer<typeof sequenceRow> & { campaign_id: string | null; created_at: string | null; updated_at: string | null }>
      campaign_leads: Omit<Table<EnrollmentRow>, 'Relationships'> & { Relationships: [{ foreignKeyName: 'campaign_leads_lead_id_fkey'; columns: ['lead_id']; isOneToOne: false; referencedRelation: 'leads'; referencedColumns: ['id'] }] }
      leads: Table<LeadRow>
    }
    Views: { [_ in never]: never }
    Functions: { campaign_core_mutate: { Args: { p_actor: string; p_org: string; p_campaign: string | null; p_operation: string; p_payload: Json; p_expected_updated_at: string | null }; Returns: Json } }
    Enums: { [_ in never]: never }
    CompositeTypes: { [_ in never]: never }
  }
}
const messages: Record<string, [number, string]> = {
  forbidden: [403, 'Only organization owners and admins may change campaigns'],
  not_found: [404, 'Campaign not found'], not_editable: [409, 'Only draft or paused campaigns can be edited'],
  stale_revision: [409, 'Campaign changed; reload before saving'], foreign_resource: [400, 'Leads, lists and senders must belong to your organization; leads must be validated'],
  stale_sender_connection: [409, 'Sender connection changed; reload before saving'],
  invalid_input: [400, 'Invalid campaign configuration'], invalid_transition: [409, 'Campaign status changed or action is not allowed'],
  execution_not_ready: [503, 'Campaign execution is not ready: durable sending and receipt tracking must be configured before launch'],
}
export function throwStorageError(error: { message: string }): never {
  const code = /campaign_core:([a-z_]+)/.exec(error.message)?.[1]
  const mapped = code ? messages[code] : undefined
  if (mapped) throw new WinnrApiError(mapped[0], code === 'forbidden' ? 'forbidden' : 'bad_request', mapped[1])
  throw new WinnrApiError(500, 'internal_error', 'Campaign storage operation failed')
}
export class CampaignCoreRepository {
  constructor(private readonly client: SupabaseClient<CampaignCoreDatabase>) {}
  async list(org: string, page: number, limit: number, status?: z.infer<typeof campaignStatus>) {
    let query = this.client.from('campaigns').select('*', { count: 'exact' }).eq('organization_id', org)
    if (status) query = query.eq('status', status)
    const { data, error, count } = await query.order('created_at', { ascending: false }).range((page - 1) * limit, page * limit - 1)
    if (error) throwStorageError(error)
    return { campaigns: (data ?? []).map(row => campaignFromRow(campaignRow.parse(row))), pagination: { page, limit, total: count ?? 0, totalPages: Math.ceil((count ?? 0) / limit) } }
  }
  async get(org: string, id: string) {
    const { data, error } = await this.client.from('campaigns').select('*').eq('organization_id', org).eq('id', id).maybeSingle()
    if (error) throwStorageError(error)
    if (!data) throw new WinnrApiError(404, 'bad_request', 'Campaign not found')
    return campaignFromRow(campaignRow.parse(data))
  }
  async sequences(org: string, id: string) {
    const campaign = await this.get(org, id)
    const { data, error } = await this.client.from('campaign_sequences').select('*').eq('campaign_id', id).order('step_number')
    if (error) throwStorageError(error)
    return { steps: (data ?? []).map(row => sequenceFromRow(sequenceRow.parse(row))), expectedUpdatedAt: campaign.updatedAt }
  }
  async leads(org: string, id: string, page: number, limit: number, status?: string, search?: string) {
    await this.get(org, id)
    // An inner join filters ownership before count/pagination, including any
    // legacy cross-tenant associations; no client-side capped audience scan.
    let query = this.client.from('campaign_leads').select('*, leads!inner(id, email, first_name, last_name, company, title, organization_id)', { count: 'exact' })
      .eq('campaign_id', id).eq('leads.organization_id', org)
    if (search) query = query.ilike('leads.email', `%${search.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`)
    if (status && status !== 'all') query = query.eq('status', status)
    const { data, error, count } = await query.order('created_at', { ascending: false }).range((page - 1) * limit, page * limit - 1)
    if (error) throwStorageError(error)
    const leads = (data ?? []).map(enrollment => ({
      id: enrollment.id, leadId: enrollment.lead_id, email: enrollment.leads.email,
      firstName: enrollment.leads.first_name, lastName: enrollment.leads.last_name,
      company: enrollment.leads.company, title: enrollment.leads.title,
      status: enrollment.status, currentStep: enrollment.current_step,
      lastSentAt: enrollment.last_sent_at, nextSendAt: enrollment.next_send_at,
    }))
    return { leads, page, limit, total: count ?? 0, totalPages: Math.ceil((count ?? 0) / limit) }
  }
  async mutate(actor: string, org: string, id: string | null, operation: string, payload: Json = {}, revision: string | null = null) {
    const { data, error } = await this.client.rpc('campaign_core_mutate', { p_actor: actor, p_org: org, p_campaign: id, p_operation: operation, p_payload: payload, p_expected_updated_at: revision })
    if (error) throwStorageError(error)
    const result = z.object({ campaign: campaignRow.optional(), added: z.number().optional(), deleted: z.boolean().optional() }).parse(data)
    return { campaign: result.campaign ? campaignFromRow(result.campaign) : undefined, added: result.added, deleted: result.deleted }
  }
}
export function createCampaignRepository() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new WinnrApiError(503, 'service_unavailable', 'Campaign storage is not configured')
  return new CampaignCoreRepository(createClient<CampaignCoreDatabase>(url, key, { auth: { persistSession: false, autoRefreshToken: false } }))
}
