/**
 * Message Sync Service
 *
 * Main orchestration service for syncing emails from connected accounts
 * into the unified inbox. Supports Google, Microsoft, and SMTP/IMAP accounts.
 */

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { decrypt } from '@/lib/encryption'
import type { Tables, InsertTables, UpdateTables, Json } from '@/types/database'
import {
  EmailProvider,
  SyncState,
  SyncOptions,
  SyncResult,
  SyncError,
  AccountCredentials,
  InboxMessage,
} from './types'
import { gmailSyncProvider } from './providers/gmail-sync'
import { microsoftSyncProvider } from './providers/microsoft-sync'
import { imapSyncProvider } from './providers/imap-sync'
import {
  normalizeMessage,
  mergeMessageUpdates,
  NormalizedMessage,
} from './parser'

// Type aliases for database tables
type EmailAccountRow = Tables<'email_accounts'>
type SyncStateRow = Tables<'sync_states'>
type InboxMessageRow = Tables<'inbox_messages'>
type ThreadRow = Tables<'threads'>

// Re-export types for convenience
export * from './types'
export * from './parser'

/**
 * Sync all email accounts for an organization
 */
export async function syncAllAccounts(
  organizationId: string,
  options: SyncOptions = {}
): Promise<{
  results: SyncResult[]
  totalMessages: number
  totalErrors: number
}> {
  const supabase = await createClient()

  // Get all active email accounts for this organization
  const { data: accountsData, error: accountsError } = await supabase
    .from('email_accounts')
    .select('id, email, provider, status, oauth_tokens_encrypted, smtp_host, smtp_port, smtp_username, smtp_password_encrypted, imap_host, imap_port')
    .eq('organization_id', organizationId)
    .in('status', ['active', 'warming'])

  if (accountsError) {
    throw new Error(`Failed to fetch accounts: ${accountsError.message}`)
  }

  const accounts = accountsData as Pick<EmailAccountRow, 'id' | 'email' | 'provider' | 'status' | 'oauth_tokens_encrypted' | 'smtp_host' | 'smtp_port' | 'smtp_username' | 'smtp_password_encrypted' | 'imap_host' | 'imap_port'>[] | null

  if (!accounts || accounts.length === 0) {
    return { results: [], totalMessages: 0, totalErrors: 0 }
  }

  // Sync each account in parallel with concurrency limit
  const CONCURRENCY = 3
  const results: SyncResult[] = []

  for (let i = 0; i < accounts.length; i += CONCURRENCY) {
    const batch = accounts.slice(i, i + CONCURRENCY)
    const batchResults = await Promise.all(
      batch.map((account) => syncAccount(account.id, options).catch((error) => ({
        success: false,
        accountId: account.id,
        messagesAdded: 0,
        messagesUpdated: 0,
        threadsCreated: 0,
        threadsUpdated: 0,
        errors: [{
          error: error instanceof Error ? error.message : 'Unknown error',
          retryable: true,
        }],
        syncDuration: 0,
        newSyncState: {},
      })))
    )
    results.push(...batchResults)
  }

  return {
    results,
    totalMessages: results.reduce((sum, r) => sum + r.messagesAdded, 0),
    totalErrors: results.reduce((sum, r) => sum + r.errors.length, 0),
  }
}

/**
 * Sync a single email account
 */
export async function syncAccount(
  accountId: string,
  options: SyncOptions = {}
): Promise<SyncResult> {
  const startTime = Date.now()
  const errors: SyncError[] = []

  const supabase = await createClient()

  // Get account details
  const { data: accountData, error: accountError } = await supabase
    .from('email_accounts')
    .select('*, organization_id')
    .eq('id', accountId)
    .single()

  const account = accountData as EmailAccountRow | null

  if (accountError || !account) {
    return {
      success: false,
      accountId,
      messagesAdded: 0,
      messagesUpdated: 0,
      threadsCreated: 0,
      threadsUpdated: 0,
      errors: [{ error: 'Account not found', retryable: false }],
      syncDuration: Date.now() - startTime,
      newSyncState: {},
    }
  }

  // Get or create sync state
  const syncState = await getSyncState(accountId)

  // Mark sync as in progress
  await updateSyncState(accountId, { status: 'syncing' })

  try {
    // Build credentials
    const credentials = await buildCredentials(account)

    // Get the appropriate provider
    const provider = getProvider(account.provider as EmailProvider)

    // Determine sync options
    const syncOptions: SyncOptions = {
      ...options,
      fullSync: options.fullSync || !syncState,
      since: options.since || (syncState?.lastSyncAt ? new Date(syncState.lastSyncAt) : undefined),
    }

    // Fetch messages from provider
    const { messages, newSyncState, hasMore } = await provider.fetchMessages(
      credentials,
      syncState,
      syncOptions
    )

    // Process and store messages
    const processResult = await processMessages(
      messages,
      account.organization_id || '',
      accountId
    )

    // Update sync state
    const finalSyncState: Partial<SyncState> = {
      ...newSyncState,
      status: 'completed',
      lastSyncAt: new Date(),
      errorMessage: null,
      errorCount: 0,
    }

    await updateSyncState(accountId, finalSyncState)

    // Continue syncing if there are more messages
    if (hasMore && !options.maxResults) {
      // Recursively sync more messages
      const moreResult = await syncAccount(accountId, {
        ...options,
        fullSync: false,
      })

      return {
        success: moreResult.success && errors.length === 0,
        accountId,
        messagesAdded: processResult.messagesAdded + moreResult.messagesAdded,
        messagesUpdated: processResult.messagesUpdated + moreResult.messagesUpdated,
        threadsCreated: processResult.threadsCreated + moreResult.threadsCreated,
        threadsUpdated: processResult.threadsUpdated + moreResult.threadsUpdated,
        errors: [...errors, ...moreResult.errors],
        syncDuration: Date.now() - startTime,
        newSyncState: finalSyncState,
      }
    }

    return {
      success: errors.length === 0,
      accountId,
      messagesAdded: processResult.messagesAdded,
      messagesUpdated: processResult.messagesUpdated,
      threadsCreated: processResult.threadsCreated,
      threadsUpdated: processResult.threadsUpdated,
      errors,
      syncDuration: Date.now() - startTime,
      newSyncState: finalSyncState,
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown sync error'

    // Handle specific errors
    if (errorMessage === 'HISTORY_EXPIRED' || errorMessage === 'DELTA_EXPIRED') {
      // Retry with full sync
      return syncAccount(accountId, { ...options, fullSync: true })
    }

    // Update sync state with error
    await updateSyncState(accountId, {
      status: 'error',
      errorMessage,
      errorCount: (syncState?.errorCount || 0) + 1,
    })

    return {
      success: false,
      accountId,
      messagesAdded: 0,
      messagesUpdated: 0,
      threadsCreated: 0,
      threadsUpdated: 0,
      errors: [{ error: errorMessage, retryable: true }],
      syncDuration: Date.now() - startTime,
      newSyncState: { status: 'error', errorMessage },
    }
  }
}

/**
 * Build credentials from account data
 */
async function buildCredentials(account: Record<string, unknown>): Promise<AccountCredentials> {
  const provider = account.provider as EmailProvider

  const credentials: AccountCredentials = {
    accountId: account.id as string,
    provider,
    email: account.email as string,
  }

  if (provider === 'google' || provider === 'microsoft') {
    // Decrypt OAuth tokens
    if (account.oauth_tokens_encrypted) {
      const tokenString = typeof account.oauth_tokens_encrypted === 'string'
        ? account.oauth_tokens_encrypted
        : JSON.stringify(account.oauth_tokens_encrypted)

      try {
        const tokens = JSON.parse(decrypt(tokenString)) as {
          access_token?: string
          refresh_token?: string
          expires_at?: number
        }

        credentials.accessToken = tokens.access_token
        credentials.refreshToken = tokens.refresh_token
        if (tokens.expires_at) {
          credentials.tokenExpiresAt = new Date(tokens.expires_at)
        }
      } catch {
        // Try parsing as already-decrypted JSON
        const tokens = typeof account.oauth_tokens_encrypted === 'string'
          ? JSON.parse(account.oauth_tokens_encrypted)
          : account.oauth_tokens_encrypted

        credentials.accessToken = tokens.access_token
        credentials.refreshToken = tokens.refresh_token
      }
    }
  } else if (provider === 'smtp') {
    // IMAP credentials
    credentials.imapHost = (account.imap_host as string) || undefined
    credentials.imapPort = (account.imap_port as number) || undefined
    credentials.imapUser = (account.smtp_username as string) || undefined

    if (account.smtp_password_encrypted) {
      try {
        credentials.imapPassword = decrypt(account.smtp_password_encrypted as string)
      } catch {
        credentials.imapPassword = account.smtp_password_encrypted as string
      }
    }

    credentials.imapSecure = true
  }

  return credentials
}

/**
 * Get the appropriate sync provider
 */
function getProvider(providerType: EmailProvider) {
  switch (providerType) {
    case 'google':
      return gmailSyncProvider
    case 'microsoft':
      return microsoftSyncProvider
    case 'smtp':
      return imapSyncProvider
    default:
      throw new Error(`Unknown provider: ${providerType}`)
  }
}

/**
 * Get sync state for an account
 */
async function getSyncState(accountId: string): Promise<SyncState | null> {
  const supabase = await createClient()

  const { data: rawData } = await supabase
    .from('sync_states')
    .select('*')
    .eq('account_id', accountId)
    .single()

  const data = rawData as SyncStateRow | null

  if (!data) return null

  return {
    accountId: data.account_id,
    lastSyncAt: data.last_sync_at ? new Date(data.last_sync_at) : null,
    lastHistoryId: data.last_history_id,
    lastDeltaLink: data.last_delta_link,
    lastUid: data.last_uid,
    syncCursor: data.sync_cursor,
    status: data.status,
    errorMessage: data.error_message,
    errorCount: data.error_count || 0,
    messagesTotal: data.messages_total || 0,
    messagesSynced: data.messages_synced || 0,
  }
}

/**
 * Update sync state for an account
 */
async function updateSyncState(
  accountId: string,
  updates: Partial<SyncState>
): Promise<void> {
  const supabase = await createClient()

  const data: InsertTables<'sync_states'> = {
    account_id: accountId,
    updated_at: new Date().toISOString(),
  }

  if (updates.lastSyncAt !== undefined) data.last_sync_at = updates.lastSyncAt?.toISOString() || null
  if (updates.lastHistoryId !== undefined) data.last_history_id = updates.lastHistoryId
  if (updates.lastDeltaLink !== undefined) data.last_delta_link = updates.lastDeltaLink
  if (updates.lastUid !== undefined) data.last_uid = updates.lastUid
  if (updates.syncCursor !== undefined) data.sync_cursor = updates.syncCursor
  if (updates.status !== undefined) data.status = updates.status
  if (updates.errorMessage !== undefined) data.error_message = updates.errorMessage
  if (updates.errorCount !== undefined) data.error_count = updates.errorCount
  if (updates.messagesTotal !== undefined) data.messages_total = updates.messagesTotal
  if (updates.messagesSynced !== undefined) data.messages_synced = updates.messagesSynced

  // @ts-expect-error - sync_states table will be created via migration
  await supabase.from('sync_states').upsert(data, { onConflict: 'account_id' })
}

/**
 * Process and store messages in the database
 */
async function processMessages(
  messages: InboxMessage[],
  organizationId: string,
  accountId: string
): Promise<{
  messagesAdded: number
  messagesUpdated: number
  threadsCreated: number
  threadsUpdated: number
}> {
  const supabase = await createClient()
  let messagesAdded = 0
  let messagesUpdated = 0
  let threadsCreated = 0
  let threadsUpdated = 0

  if (messages.length === 0) {
    return { messagesAdded, messagesUpdated, threadsCreated, threadsUpdated }
  }

  // Normalize messages
  const normalizedMessages = messages.map((m) => normalizeMessage(m))

  // Get existing messages by external ID to detect duplicates
  const externalIds = normalizedMessages.map((m) => m.externalId)
  const { data: existingMessagesData } = await supabase
    .from('inbox_messages')
    .select('id, external_id, message_id, is_read, category_confidence')
    .eq('account_id', accountId)
    .in('external_id', externalIds)

  const existingMessages = existingMessagesData as Pick<InboxMessageRow, 'id' | 'external_id' | 'message_id' | 'is_read' | 'category_confidence'>[] | null

  const existingByExternalId = new Map(
    (existingMessages || []).map((m) => [m.external_id, m])
  )

  // Process each message
  for (const normalized of normalizedMessages) {
    const existing = existingByExternalId.get(normalized.externalId)

    if (existing) {
      // Check for updates
      const inboxMessage = messages.find((m) => m.externalId === normalized.externalId)
      if (inboxMessage) {
        const updates = mergeMessageUpdates(
          { ...normalized, id: existing.id } as NormalizedMessage,
          inboxMessage
        )

        if (Object.keys(updates).length > 0) {
          const updateData: UpdateTables<'inbox_messages'> = {
            updated_at: new Date().toISOString(),
          }
          if (updates.isRead !== undefined) updateData.is_read = updates.isRead
          if (updates.bodyText !== undefined) updateData.body_text = updates.bodyText
          if (updates.bodyHtml !== undefined) updateData.body_html = updates.bodyHtml
          if (updates.category !== undefined) updateData.category = updates.category
          if (updates.sentiment !== undefined) updateData.sentiment = updates.sentiment
          if (updates.categoryConfidence !== undefined) updateData.category_confidence = updates.categoryConfidence

          // @ts-expect-error - inbox_messages table will be created via migration
          await supabase.from('inbox_messages').update(updateData).eq('id', existing.id)

          messagesUpdated++
        }
      }
    } else {
      // Insert new message
      const insertData: InsertTables<'inbox_messages'> = {
        id: normalized.id,
        external_id: normalized.externalId,
        account_id: accountId,
        organization_id: organizationId,
        thread_id: normalized.threadId,
        message_id: normalized.messageId,
        in_reply_to: normalized.inReplyTo,
        references: normalized.references,
        from_email: normalized.fromEmail,
        from_name: normalized.fromName,
        to_emails: normalized.toEmails,
        cc_emails: normalized.ccEmails,
        subject: normalized.subject,
        body_text: normalized.bodyText,
        body_html: normalized.bodyHtml,
        snippet: normalized.snippet,
        is_read: normalized.isRead,
        direction: normalized.direction,
        category: normalized.category,
        sentiment: normalized.sentiment,
        category_confidence: normalized.categoryConfidence,
        has_attachments: normalized.hasAttachments,
        provider: normalized.provider,
        received_at: normalized.receivedAt.toISOString(),
        internal_date: normalized.internalDate.toISOString(),
        raw_data: normalized.rawData as unknown as Json,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      // @ts-expect-error - inbox_messages table will be created via migration
      const { error: insertError } = await supabase.from('inbox_messages').insert(insertData)

      if (!insertError) {
        messagesAdded++

        // Update or create thread
        const threadResult = await upsertThread(
          normalized,
          organizationId,
          accountId
        )
        if (threadResult.created) threadsCreated++
        if (threadResult.updated) threadsUpdated++

        // Link inbound replies to campaigns (auto-pause sequence on reply)
        if (normalized.direction === 'inbound') {
          await linkReplyToCampaign(normalized, organizationId, accountId)
        }
      }
    }
  }

  return { messagesAdded, messagesUpdated, threadsCreated, threadsUpdated }
}

/**
 * Update or create thread for a message
 */
async function upsertThread(
  message: NormalizedMessage,
  organizationId: string,
  accountId: string
): Promise<{ created: boolean; updated: boolean }> {
  const supabase = await createClient()

  // Check if thread exists
  const { data: existingThreadData } = await supabase
    .from('threads')
    .select('id, message_count, last_message_at')
    .eq('organization_id', organizationId)
    .eq('thread_external_id', message.threadId)
    .single()

  const existingThread = existingThreadData as Pick<ThreadRow, 'id' | 'message_count' | 'last_message_at'> | null

  if (existingThread) {
    // Update thread
    const shouldUpdate =
      !existingThread.last_message_at ||
      new Date(message.receivedAt) > new Date(existingThread.last_message_at)

    if (shouldUpdate) {
      const updateData: UpdateTables<'threads'> = {
        last_message_at: message.receivedAt.toISOString(),
        message_count: (existingThread.message_count || 0) + 1,
        category: message.category as UpdateTables<'threads'>['category'],
        sentiment: message.sentiment as UpdateTables<'threads'>['sentiment'],
        subject: message.subject,
        updated_at: new Date().toISOString(),
      }

      // @ts-expect-error - threads table will be created via migration
      await supabase.from('threads').update(updateData).eq('id', existingThread.id)

      return { created: false, updated: true }
    }

    return { created: false, updated: false }
  }

  // Create new thread
  const insertData: InsertTables<'threads'> = {
    organization_id: organizationId,
    mailbox_id: accountId,
    thread_external_id: message.threadId,
    subject: message.subject,
    participant_email: message.direction === 'inbound' ? message.fromEmail : (message.toEmails[0] || ''),
    participant_name: message.direction === 'inbound' ? message.fromName : null,
    message_count: 1,
    last_message_at: message.receivedAt.toISOString(),
    status: 'active',
    category: message.category as InsertTables<'threads'>['category'],
    sentiment: message.sentiment as InsertTables<'threads'>['sentiment'],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  // @ts-expect-error - threads table will be created via migration
  await supabase.from('threads').insert(insertData)

  return { created: true, updated: false }
}

/**
 * Link inbound reply to campaign and update lead status
 *
 * When a reply comes in, we need to:
 * 1. Find the original outbound message via In-Reply-To or References headers
 * 2. Check if that message was part of a campaign (has campaign_id/lead_id)
 * 3. Update campaign_leads.status to 'replied' to stop the sequence
 */
async function linkReplyToCampaign(
  message: NormalizedMessage,
  organizationId: string,
  accountId: string
): Promise<{ linked: boolean; campaignId?: string; leadId?: string }> {
  // Only process inbound messages with reply context
  if (message.direction !== 'inbound') {
    return { linked: false }
  }

  // Get message IDs to look up (from In-Reply-To and References)
  const referencedIds: string[] = []

  if (message.inReplyTo) {
    referencedIds.push(message.inReplyTo)
  }

  if (message.references && Array.isArray(message.references)) {
    referencedIds.push(...message.references)
  }

  if (referencedIds.length === 0) {
    return { linked: false }
  }

  try {
    const adminClient = createAdminClient()

    console.log(`[InboxSync] Looking up sent emails for message IDs: ${referencedIds.join(', ')}`)

    // Look up sent emails that match the referenced message IDs
    // campaign_id and lead_id are stored directly on sent_emails
    const { data: sentEmails, error: sentEmailsError } = await adminClient
      .from('sent_emails')
      .select('id, message_id, campaign_id, lead_id')
      .eq('organization_id', organizationId)
      .in('message_id', referencedIds)

    if (sentEmailsError) {
      console.error('[InboxSync] Error querying sent_emails:', sentEmailsError)
    }

    if (sentEmails && sentEmails.length > 0) {
      // Found sent email(s) - get campaign and lead info
      for (const sentEmail of sentEmails) {
        const campaignId = sentEmail.campaign_id
        const leadId = sentEmail.lead_id

        if (campaignId && leadId) {
          console.log(`[InboxSync] Found matching sent email, linking to campaign ${campaignId}, lead ${leadId}`)
          await updateCampaignLeadStatus(campaignId, leadId, 'replied')
          return { linked: true, campaignId, leadId }
        }
      }
    }

    // Fallback: check inbox_messages for outbound messages with campaign headers in raw_data
    const { data: outboundMessages } = await adminClient
      .from('inbox_messages')
      .select('id, message_id, raw_data')
      .eq('organization_id', organizationId)
      .eq('direction', 'outbound')
      .in('message_id', referencedIds)

    if (outboundMessages && outboundMessages.length > 0) {
      // Check raw_data for campaign headers
      for (const outbound of outboundMessages) {
        const rawData = outbound.raw_data as Record<string, unknown> | null
        if (rawData?.headers) {
          const headers = rawData.headers as Record<string, string>
          const campaignId = headers['X-Campaign-ID'] || headers['x-campaign-id']
          const leadId = headers['X-Lead-ID'] || headers['x-lead-id']

          if (campaignId && leadId) {
            console.log(`[InboxSync] Found via inbox_messages headers, linking to campaign ${campaignId}, lead ${leadId}`)
            await updateCampaignLeadStatus(campaignId, leadId, 'replied')
            return { linked: true, campaignId, leadId }
          }
        }
      }
    }

    console.log(`[InboxSync] No matching campaign email found for message IDs: ${referencedIds.join(', ')}`)
    return { linked: false }
  } catch (error) {
    console.error('[InboxSync] Error linking reply to campaign:', error)
    return { linked: false }
  }
}

/**
 * Update campaign_leads status to stop the sequence
 */
async function updateCampaignLeadStatus(
  campaignId: string,
  leadId: string,
  status: 'replied' | 'bounced' | 'unsubscribed'
): Promise<void> {
  const adminClient = createAdminClient()

  console.log(`[InboxSync] Updating campaign_leads status: campaign=${campaignId}, lead=${leadId}, status=${status}`)

  // Update campaign_leads status
  const { error, count } = await adminClient
    .from('campaign_leads')
    .update({
      status,
      replied_at: status === 'replied' ? new Date().toISOString() : undefined,
      updated_at: new Date().toISOString(),
    })
    .eq('campaign_id', campaignId)
    .eq('lead_id', leadId)

  if (error) {
    console.error(`[InboxSync] Failed to update campaign_leads status:`, error)
    return
  }

  console.log(`[InboxSync] Updated campaign_leads (rows affected: ${count ?? 'unknown'})`)

  // Also update lead status in leads table
  const { error: leadError } = await adminClient
    .from('leads')
    .update({
      status: status === 'replied' ? 'replied' : 'contacted',
      last_contacted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', leadId)

  if (leadError) {
    console.error(`[InboxSync] Failed to update lead status:`, leadError)
  }

  // Increment reply count on campaign stats
  if (status === 'replied') {
    const { error: rpcError } = await adminClient.rpc('increment_campaign_replies', { p_campaign_id: campaignId })
    if (rpcError) {
      console.error(`[InboxSync] Failed to increment campaign replies:`, rpcError)
    } else {
      console.log(`[InboxSync] Incremented campaign reply count for ${campaignId}`)
    }
  }
}

/**
 * Get sync status for all accounts in an organization
 */
export async function getOrganizationSyncStatus(
  organizationId: string
): Promise<{
  accounts: Array<{
    id: string
    email: string
    provider: EmailProvider
    lastSyncAt: Date | null
    status: string
    messagesTotal: number
    errorMessage: string | null
  }>
  overallHealth: 'healthy' | 'warning' | 'error'
}> {
  const supabase = await createClient()

  const { data: accountsData } = await supabase
    .from('email_accounts')
    .select(`
      id,
      email,
      provider,
      status
    `)
    .eq('organization_id', organizationId)

  const accounts = accountsData as Pick<EmailAccountRow, 'id' | 'email' | 'provider' | 'status'>[] | null

  const { data: syncStatesData } = await supabase
    .from('sync_states')
    .select('*')
    .in('account_id', (accounts || []).map((a) => a.id))

  const syncStates = syncStatesData as SyncStateRow[] | null

  const syncStateMap = new Map(
    (syncStates || []).map((s) => [s.account_id, s])
  )

  const accountStatuses = (accounts || []).map((account) => {
    const syncState = syncStateMap.get(account.id)
    return {
      id: account.id,
      email: account.email,
      provider: account.provider as EmailProvider,
      lastSyncAt: syncState?.last_sync_at ? new Date(syncState.last_sync_at) : null,
      status: syncState?.status || 'idle',
      messagesTotal: syncState?.messages_total || 0,
      errorMessage: syncState?.error_message || null,
    }
  })

  // Determine overall health
  const hasErrors = accountStatuses.some((a) => a.status === 'error')
  const hasStaleSync = accountStatuses.some((a) => {
    if (!a.lastSyncAt) return true
    const hoursSinceSync = (Date.now() - a.lastSyncAt.getTime()) / (1000 * 60 * 60)
    return hoursSinceSync > 1 // Stale if more than 1 hour
  })

  let overallHealth: 'healthy' | 'warning' | 'error' = 'healthy'
  if (hasErrors) {
    overallHealth = 'error'
  } else if (hasStaleSync) {
    overallHealth = 'warning'
  }

  return {
    accounts: accountStatuses,
    overallHealth,
  }
}

/**
 * Force a full resync for an account (clears sync state)
 */
export async function forceFullResync(accountId: string): Promise<SyncResult> {
  const supabase = await createClient()

  // Clear sync state
  await supabase
    .from('sync_states')
    .delete()
    .eq('account_id', accountId)

  // Run full sync
  return syncAccount(accountId, { fullSync: true })
}
