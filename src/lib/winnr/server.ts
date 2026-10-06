/**
 * Organization-scoped Winnr server service (launch plan Task 3).
 *
 * This module owns the decisions that must not be entrusted to the UI or a
 * provider adapter:
 *   - membership is resolved from the authenticated identity, never an input;
 *   - a token is verified against `GET /v1/account` before it is encrypted;
 *   - an operation reservation is durable BEFORE any provider mutation;
 *   - pending/unknown outcomes are held for manual review and never replayed;
 *   - uncertain provider outcomes are reported as uncertain, never success.
 *
 * Storage and provider access are dependency-injected so the contract can be
 * proven with fakes. The production repository lives in `./database`.
 */
import { createHash } from 'crypto'
import { encrypt } from '@/lib/encryption'
import { WinnrError, type WinnrClient } from './client'
import type {
  CursorPage,
  Domain,
  InboxMessage,
  Mailbox,
  WarmingPage,
  WinnrAccount,
  WinnrSettings,
} from './types'

export type MemberRole = 'owner' | 'admin' | 'member'

export interface WinnrAuthContext {
  userId: string
  organizationId: string
  role: MemberRole
}

export interface WinnrConnectionRecord {
  id: string
  organizationId: string
  version: number
  providerAccountId: string
  accountName: string
  accountPlan: string | null
  permissions: string[]
  universalInboxEnabled: boolean
  connectedAt: string
  verifiedAt: string
}

export interface WinnrConnectionView {
  id: string
  version: number
  account: WinnrAccount
  connectedAt: string
  verifiedAt: string
}

export interface WinnrConnectionEnvelope {
  connection: WinnrConnectionView | null
  canManage: boolean
}

export type WarmingAction = 'enable' | 'pause' | 'resume'
export type OperationStatus = 'pending' | 'succeeded' | 'rejected' | 'unknown'

export interface ReserveOperationInput {
  organizationId: string
  operationId: string
  connectionId: string
  connectionVersion: number
  action: WarmingAction
  mailboxIds: string[]
  fingerprint: string
}

export type ReserveResult =
  | { result: 'reserved' }
  | { result: 'duplicate'; status: OperationStatus }
  | { result: 'fingerprint_mismatch' }
  | { result: 'operation_id_conflict' }
  | { result: 'blocked'; status: OperationStatus; operationId: string | null }
  | { result: 'stale' }
  | { result: 'not_found' }

export interface SaveConnectionInput {
  organizationId: string
  providerAccountId: string
  tokenCiphertext: string
  accountName: string
  accountPlan: string | null
  permissions: string[]
  universalInboxEnabled: boolean
  expectedConnectionId: string | null
  expectedVersion: number | null
}

export type SaveConnectionResult =
  | { result: 'saved'; connectionId: string; version: number }
  | { result: 'stale' }
  | { result: 'blocked' }
  | { result: 'account_taken' }

export interface DeleteConnectionInput {
  organizationId: string
  expectedConnectionId: string
  expectedVersion: number
}

export type DeleteConnectionResult =
  | { result: 'deleted' }
  | { result: 'stale' }
  | { result: 'blocked' }
  | { result: 'not_found' }

export interface SettleOperationInput {
  organizationId: string
  operationId: string
  status: Exclude<OperationStatus, 'pending'>
  errorCode: string | null
}

export interface WinnrRepository {
  getConnection(organizationId: string): Promise<WinnrConnectionRecord | null>
  getConnectionWithToken(
    organizationId: string
  ): Promise<{ connection: WinnrConnectionRecord; token: string } | null>
  saveConnection(input: SaveConnectionInput): Promise<SaveConnectionResult>
  deleteConnection(input: DeleteConnectionInput): Promise<DeleteConnectionResult>
  reserveOperation(input: ReserveOperationInput): Promise<ReserveResult>
  settleOperation(input: SettleOperationInput): Promise<boolean>
}

export interface WinnrServiceDeps {
  repository: WinnrRepository
  createProvider: (token: string) => WinnrClient
  /** Defaults to the real AES-GCM helper; injected only in tests. */
  encryptToken?: (token: string) => string
  now?: () => Date
}

export interface ConnectAccountInput {
  token: string
  expectedConnectionId: string | null
  expectedVersion: number | null
}

export interface WarmingMutationInput {
  action: WarmingAction
  connectionId: string
  connectionVersion: number
  operationId: string
  mailboxIds: string[]
  confirmPaid?: boolean
}

export interface WarmingMutationResult {
  operation: { id: string; status: 'succeeded' }
  observedAt: string
}

export interface ReadObservation {
  observedAt: string
  connectionId: string
  connectionVersion: number
}

export interface MailboxPage extends CursorPage<Mailbox>, ReadObservation {}
export interface DomainPage extends CursorPage<Domain>, ReadObservation {}
export interface InboxPage extends CursorPage<InboxMessage>, ReadObservation {}
export interface WarmingObservationPage extends WarmingPage, ReadObservation {}

/** Conservative, explicit first-release warm-up settings. */
export const CONSERVATIVE_WARMING_SETTINGS: WinnrSettings = {
  emailsPerDay: 10,
  responseRate: 30,
  rampupEnabled: true,
  rampupSpeed: 'slow',
}

export type WinnrApiErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'bad_request'
  | 'not_connected'
  | 'stale_connection'
  | 'conflict'
  | 'operation_pending'
  | 'outcome_unknown'
  | 'provider_error'
  | 'service_unavailable'
  | 'internal_error'

export interface WinnrErrorBody {
  error: {
    code: string
    message: string
    outcomeUnknown?: boolean
    operationId?: string
  }
}

export class WinnrApiError extends Error {
  readonly status: number
  readonly code: WinnrApiErrorCode
  readonly outcomeUnknown: boolean
  readonly operationId: string | undefined

  constructor(
    status: number,
    code: WinnrApiErrorCode,
    message: string,
    options: { outcomeUnknown?: boolean; operationId?: string } = {}
  ) {
    super(message)
    this.name = 'WinnrApiError'
    this.status = status
    this.code = code
    this.outcomeUnknown = options.outcomeUnknown ?? false
    this.operationId = options.operationId
  }

  toBody(): WinnrErrorBody {
    const error: WinnrErrorBody['error'] = { code: this.code, message: this.message }
    if (this.outcomeUnknown) error.outcomeUnknown = true
    if (this.operationId) error.operationId = this.operationId
    return { error }
  }
}

const SAFE_ID = /^[A-Za-z0-9_.:@-]{1,200}$/
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/

export function isManager(role: MemberRole): boolean {
  return role === 'owner' || role === 'admin'
}

function nowIso(deps: WinnrServiceDeps): string {
  return (deps.now ? deps.now() : new Date()).toISOString()
}

function assertManager(ctx: WinnrAuthContext): void {
  if (!isManager(ctx.role)) {
    throw new WinnrApiError(403, 'forbidden', 'Only owners and admins can manage the Winnr connection')
  }
}

function safeId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value) && !value.includes('..')
}

export function createFingerprint(input: {
  action: WarmingAction
  connectionId: string
  connectionVersion: number
  mailboxIds: string[]
}): string {
  const canonical = JSON.stringify({
    action: input.action,
    connectionId: input.connectionId,
    connectionVersion: input.connectionVersion,
    mailboxIds: [...input.mailboxIds],
  })
  return createHash('sha256').update(canonical).digest('hex')
}

function toConnectionView(record: WinnrConnectionRecord): WinnrConnectionView {
  return {
    id: record.id,
    version: record.version,
    account: {
      id: record.providerAccountId,
      name: record.accountName,
      plan: record.accountPlan,
      permissions: record.permissions,
      universalInboxEnabled: record.universalInboxEnabled,
    },
    connectedAt: record.connectedAt,
    verifiedAt: record.verifiedAt,
  }
}

function envelope(record: WinnrConnectionRecord | null, ctx: WinnrAuthContext): WinnrConnectionEnvelope {
  return {
    connection: record ? toConnectionView(record) : null,
    canManage: isManager(ctx.role),
  }
}

async function requireConnection(
  ctx: WinnrAuthContext,
  deps: WinnrServiceDeps
): Promise<{ connection: WinnrConnectionRecord; token: string }> {
  const found = await deps.repository.getConnectionWithToken(ctx.organizationId)
  if (!found) {
    throw new WinnrApiError(409, 'not_connected', 'No Winnr connection exists for this organization')
  }
  if (!found.connection.permissions.includes('read')) {
    throw new WinnrApiError(403, 'forbidden', 'The Winnr token requires read permission')
  }
  return found
}

function mapReadError(error: unknown): never {
  if (error instanceof WinnrApiError) throw error
  if (error instanceof WinnrError) {
    throw new WinnrApiError(502, 'provider_error', 'Winnr could not complete the read request', {
      outcomeUnknown: false,
    })
  }
  throw new WinnrApiError(502, 'provider_error', 'Winnr could not complete the read request')
}

function mapConnectError(error: unknown): never {
  if (error instanceof WinnrError) {
    throw new WinnrApiError(502, 'provider_error', 'Winnr did not accept this API token')
  }
  throw new WinnrApiError(502, 'provider_error', 'Winnr did not accept this API token')
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export async function getConnectionEnvelope(
  ctx: WinnrAuthContext,
  deps: WinnrServiceDeps
): Promise<WinnrConnectionEnvelope> {
  const record = await deps.repository.getConnection(ctx.organizationId)
  return envelope(record, ctx)
}

export async function connectAccount(
  ctx: WinnrAuthContext,
  deps: WinnrServiceDeps,
  input: ConnectAccountInput
): Promise<WinnrConnectionEnvelope> {
  assertManager(ctx)

  if (typeof input.token !== 'string' || input.token.length === 0 || /\s/.test(input.token)) {
    throw new WinnrApiError(400, 'bad_request', 'A valid Winnr API token is required')
  }

  const provider = deps.createProvider(input.token)

  let account: WinnrAccount
  try {
    account = await provider.getAccount()
  } catch (error) {
    mapConnectError(error)
  }
  if (!account.permissions.includes('read')) {
    throw new WinnrApiError(403, 'forbidden', 'The Winnr token requires read permission')
  }

  let tokenCiphertext: string
  try {
    tokenCiphertext = (deps.encryptToken ?? encrypt)(input.token)
  } catch {
    // Encryption configuration is missing or broken. Never store the token.
    throw new WinnrApiError(503, 'service_unavailable', 'Credential storage is not configured')
  }

  const save = await deps.repository.saveConnection({
    organizationId: ctx.organizationId,
    providerAccountId: account.id,
    tokenCiphertext,
    accountName: account.name,
    accountPlan: account.plan,
    permissions: account.permissions,
    universalInboxEnabled: account.universalInboxEnabled,
    expectedConnectionId: input.expectedConnectionId,
    expectedVersion: input.expectedVersion,
  })

  switch (save.result) {
    case 'saved':
      break
    case 'stale':
      throw new WinnrApiError(409, 'stale_connection', 'The Winnr connection changed; reload and retry')
    case 'blocked':
      throw new WinnrApiError(
        409,
        'operation_pending',
        'A pending or uncertain warm-up operation blocks replacing the connection'
      )
    case 'account_taken':
      throw new WinnrApiError(
        409,
        'conflict',
        'This Winnr account is already connected to another organization'
      )
  }

  const record = await deps.repository.getConnection(ctx.organizationId)
  if (!record) {
    throw new WinnrApiError(500, 'internal_error', 'The connection was not persisted')
  }
  return envelope(record, ctx)
}

export async function disconnectAccount(
  ctx: WinnrAuthContext,
  deps: WinnrServiceDeps,
  input: { expectedConnectionId: string; expectedVersion: number }
): Promise<WinnrConnectionEnvelope> {
  assertManager(ctx)
  const result = await deps.repository.deleteConnection({
    organizationId: ctx.organizationId,
    expectedConnectionId: input.expectedConnectionId,
    expectedVersion: input.expectedVersion,
  })
  switch (result.result) {
    case 'deleted':
      return { connection: null, canManage: isManager(ctx.role) }
    case 'not_found':
      throw new WinnrApiError(404, 'not_connected', 'No Winnr connection exists for this organization')
    case 'stale':
      throw new WinnrApiError(409, 'stale_connection', 'The Winnr connection changed; reload and retry')
    case 'blocked':
      throw new WinnrApiError(
        409,
        'operation_pending',
        'A pending or uncertain warm-up operation blocks disconnecting'
      )
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listMailboxes(
  ctx: WinnrAuthContext,
  deps: WinnrServiceDeps,
  params: { cursor?: string; limit?: number }
): Promise<MailboxPage> {
  const { connection, token } = await requireConnection(ctx, deps)
  let page: CursorPage<Mailbox>
  try {
    page = await deps.createProvider(token).listMailboxes(params)
  } catch (error) {
    mapReadError(error)
  }
  return { ...page, observedAt: nowIso(deps), connectionId: connection.id, connectionVersion: connection.version }
}

export async function listDomains(
  ctx: WinnrAuthContext,
  deps: WinnrServiceDeps,
  params: { cursor?: string; limit?: number }
): Promise<DomainPage> {
  const { connection, token } = await requireConnection(ctx, deps)
  let page: CursorPage<Domain>
  try {
    page = await deps.createProvider(token).listDomains(params)
  } catch (error) {
    mapReadError(error)
  }
  return { ...page, observedAt: nowIso(deps), connectionId: connection.id, connectionVersion: connection.version }
}

export async function listWarming(
  ctx: WinnrAuthContext,
  deps: WinnrServiceDeps,
  params: { page?: number; perPage?: number }
): Promise<WarmingObservationPage> {
  const { connection, token } = await requireConnection(ctx, deps)
  let page: WarmingPage
  try {
    page = await deps.createProvider(token).listWarming(params)
  } catch (error) {
    mapReadError(error)
  }
  return { ...page, observedAt: nowIso(deps), connectionId: connection.id, connectionVersion: connection.version }
}

export async function listInbox(
  ctx: WinnrAuthContext,
  deps: WinnrServiceDeps,
  params: { mailboxId?: string; cursor?: string; limit?: number }
): Promise<InboxPage> {
  const { connection, token } = await requireConnection(ctx, deps)
  let page: CursorPage<InboxMessage>
  try {
    page = await deps.createProvider(token).listInbox(params)
  } catch (error) {
    mapReadError(error)
  }
  return { ...page, observedAt: nowIso(deps), connectionId: connection.id, connectionVersion: connection.version }
}

// ---------------------------------------------------------------------------
// Warm-up mutations
// ---------------------------------------------------------------------------

export async function mutateWarming(
  ctx: WinnrAuthContext,
  deps: WinnrServiceDeps,
  input: WarmingMutationInput
): Promise<WarmingMutationResult> {
  assertManager(ctx)

  if (input.action !== 'enable' && input.action !== 'pause' && input.action !== 'resume') {
    throw new WinnrApiError(400, 'bad_request', 'Unsupported warm-up action')
  }
  if (input.action === 'enable' && input.confirmPaid !== true) {
    throw new WinnrApiError(400, 'bad_request', 'Enabling warm-up requires explicit paid confirmation')
  }
  if (!UUID.test(input.operationId)) {
    throw new WinnrApiError(400, 'bad_request', 'A valid operation id is required')
  }
  if (!safeId(input.connectionId)) {
    throw new WinnrApiError(400, 'bad_request', 'A valid connection id is required')
  }
  if (!Number.isInteger(input.connectionVersion) || input.connectionVersion < 1) {
    throw new WinnrApiError(400, 'bad_request', 'A valid connection version is required')
  }
  if (
    !Array.isArray(input.mailboxIds) ||
    input.mailboxIds.length === 0 ||
    input.mailboxIds.length > 1 ||
    !input.mailboxIds.every(safeId)
  ) {
    throw new WinnrApiError(400, 'bad_request', 'Exactly one safe mailbox id is required')
  }

  const { connection, token } = await requireConnection(ctx, deps)
  if (connection.id !== input.connectionId || connection.version !== input.connectionVersion) {
    throw new WinnrApiError(409, 'stale_connection', 'The Winnr connection changed; reload and retry')
  }
  if (!connection.permissions.includes('write')) {
    throw new WinnrApiError(403, 'forbidden', 'The Winnr token requires write permission')
  }

  const fingerprint = createFingerprint({
    action: input.action,
    connectionId: input.connectionId,
    connectionVersion: input.connectionVersion,
    mailboxIds: input.mailboxIds,
  })

  // Durable reservation BEFORE any provider mutation.
  const reservation = await deps.repository.reserveOperation({
    organizationId: ctx.organizationId,
    operationId: input.operationId,
    connectionId: input.connectionId,
    connectionVersion: input.connectionVersion,
    action: input.action,
    mailboxIds: input.mailboxIds,
    fingerprint,
  })

  switch (reservation.result) {
    case 'reserved':
      break
    case 'duplicate':
      if (reservation.status === 'pending' || reservation.status === 'unknown') {
        throw new WinnrApiError(409, 'outcome_unknown', 'This operation is already held for review', {
          outcomeUnknown: true,
          operationId: input.operationId,
        })
      }
      throw new WinnrApiError(409, 'conflict', 'This operation was already submitted', {
        operationId: input.operationId,
      })
    case 'blocked':
      throw new WinnrApiError(409, 'outcome_unknown', 'Another operation on this mailbox is held for review', {
        outcomeUnknown: true,
        ...(reservation.operationId ? { operationId: reservation.operationId } : {}),
      })
    case 'fingerprint_mismatch':
    case 'operation_id_conflict':
      throw new WinnrApiError(409, 'conflict', 'This operation id was already used with different details')
    case 'stale':
      throw new WinnrApiError(409, 'stale_connection', 'The Winnr connection changed; reload and retry')
    case 'not_found':
      throw new WinnrApiError(409, 'not_connected', 'No Winnr connection exists for this organization')
  }

  const mailboxId = input.mailboxIds[0] as string

  try {
    const provider = deps.createProvider(token)
    if (input.action === 'enable') {
      await provider.enableWarming(input.mailboxIds, CONSERVATIVE_WARMING_SETTINGS)
    } else if (input.action === 'pause') {
      await provider.pauseWarming(mailboxId)
    } else {
      await provider.resumeWarming(mailboxId)
    }
  } catch (error) {
    if (error instanceof WinnrError && !error.outcomeUnknown) {
      const settled = await trySettle(deps, {
        organizationId: ctx.organizationId,
        operationId: input.operationId,
        status: 'rejected',
        errorCode: 'provider_rejected',
      })
      if (!settled) {
        throw new WinnrApiError(409, 'outcome_unknown', 'Winnr rejected the operation but the result could not be recorded', {
          outcomeUnknown: true,
          operationId: input.operationId,
        })
      }
      throw new WinnrApiError(400, 'provider_error', 'Winnr rejected the operation')
    }
    await trySettle(deps, {
      organizationId: ctx.organizationId,
      operationId: input.operationId,
      status: 'unknown',
      errorCode: 'outcome_unknown',
    })
    throw new WinnrApiError(409, 'outcome_unknown', 'The provider outcome is uncertain; do not retry', {
      outcomeUnknown: true,
      operationId: input.operationId,
    })
  }

  const settled = await trySettle(deps, {
    organizationId: ctx.organizationId,
    operationId: input.operationId,
    status: 'succeeded',
    errorCode: null,
  })
  if (!settled) {
    throw new WinnrApiError(409, 'outcome_unknown', 'The provider accepted the operation but the result could not be recorded', {
      outcomeUnknown: true,
      operationId: input.operationId,
    })
  }

  return {
    operation: { id: input.operationId, status: 'succeeded' },
    observedAt: nowIso(deps),
  }
}

async function trySettle(deps: WinnrServiceDeps, input: SettleOperationInput): Promise<boolean> {
  try {
    return await deps.repository.settleOperation(input)
  } catch {
    return false
  }
}
