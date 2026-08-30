/**
 * E2E Test Setup
 *
 * This setup is for integration/E2E tests that test the full flow
 * from API endpoints through to database operations.
 */

import { vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'

// ============================================================================
// Test Database Configuration
// ============================================================================

// For E2E tests, we use a mock Supabase client that simulates real behavior
// In a production setup, this would connect to a test database

export interface TestUser {
  id: string
  email: string
  organization_id: string
}

export interface TestOrganization {
  id: string
  name: string
  slug: string
  plan: 'starter' | 'pro' | 'agency'
}

// In-memory test data store
export const testDataStore = {
  users: new Map<string, TestUser>(),
  organizations: new Map<string, TestOrganization>(),
  campaigns: new Map<string, Record<string, unknown>>(),
  leads: new Map<string, Record<string, unknown>>(),
  campaignLeads: new Map<string, Record<string, unknown>>(),
  emailAccounts: new Map<string, Record<string, unknown>>(),
  sentEmails: new Map<string, Record<string, unknown>>(),
  domains: new Map<string, Record<string, unknown>>(),
  inboxMessages: new Map<string, Record<string, unknown>>(),
}

export function clearTestDataStore() {
  testDataStore.users.clear()
  testDataStore.organizations.clear()
  testDataStore.campaigns.clear()
  testDataStore.leads.clear()
  testDataStore.campaignLeads.clear()
  testDataStore.emailAccounts.clear()
  testDataStore.sentEmails.clear()
  testDataStore.domains.clear()
  testDataStore.inboxMessages.clear()
}

// ============================================================================
// Mock Supabase Client for E2E Tests
// ============================================================================

export function createE2ESupabaseClient() {
  const createQueryBuilder = (tableName: string) => {
    const filters: Record<string, unknown> = {}
    let selectFields = '*'
    let insertData: Record<string, unknown> | null = null
    let updateData: Record<string, unknown> | null = null

    const getStore = () => {
      const storeMap: Record<string, Map<string, Record<string, unknown>>> = {
        users: testDataStore.users as unknown as Map<string, Record<string, unknown>>,
        organizations: testDataStore.organizations as unknown as Map<string, Record<string, unknown>>,
        campaigns: testDataStore.campaigns,
        leads: testDataStore.leads,
        campaign_leads: testDataStore.campaignLeads,
        email_accounts: testDataStore.emailAccounts,
        sent_emails: testDataStore.sentEmails,
        domains: testDataStore.domains,
        inbox_messages: testDataStore.inboxMessages,
      }
      return storeMap[tableName] || new Map()
    }

    const builder = {
      select: (fields = '*') => {
        selectFields = fields
        return builder
      },
      insert: (data: Record<string, unknown> | Record<string, unknown>[]) => {
        const items = Array.isArray(data) ? data : [data]
        items.forEach(item => {
          const id = item.id || crypto.randomUUID()
          const record = { ...item, id, created_at: new Date().toISOString() }
          getStore().set(id, record)
          insertData = record
        })
        return builder
      },
      update: (data: Record<string, unknown>) => {
        updateData = data
        return builder
      },
      delete: () => {
        return builder
      },
      eq: (field: string, value: unknown) => {
        filters[field] = value
        return builder
      },
      in: (field: string, values: unknown[]) => {
        filters[`${field}_in`] = values
        return builder
      },
      single: () => {
        const store = getStore()

        // If we just inserted, return that
        if (insertData) {
          return Promise.resolve({ data: insertData, error: null })
        }

        // If we're updating, apply updates
        if (updateData && filters.id) {
          const existing = store.get(filters.id as string)
          if (existing) {
            const updated = { ...existing, ...updateData, updated_at: new Date().toISOString() }
            store.set(filters.id as string, updated)
            return Promise.resolve({ data: updated, error: null })
          }
        }

        // Find by filters
        for (const [id, record] of store) {
          let matches = true
          for (const [key, value] of Object.entries(filters)) {
            if (record[key] !== value) {
              matches = false
              break
            }
          }
          if (matches) {
            return Promise.resolve({ data: record, error: null })
          }
        }

        return Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'Not found' } })
      },
      then: (resolve: (result: { data: unknown; error: unknown }) => void) => {
        const store = getStore()

        // If we just inserted, return that
        if (insertData) {
          return resolve({ data: insertData, error: null })
        }

        // Apply updates
        if (updateData) {
          let count = 0
          for (const [id, record] of store) {
            let matches = true
            for (const [key, value] of Object.entries(filters)) {
              if (!key.endsWith('_in') && record[key] !== value) {
                matches = false
                break
              }
            }
            if (matches) {
              const updated = { ...record, ...updateData, updated_at: new Date().toISOString() }
              store.set(id, updated)
              count++
            }
          }
          return resolve({ data: null, error: null, count })
        }

        // Return filtered results
        const results: Record<string, unknown>[] = []
        for (const [, record] of store) {
          let matches = true
          for (const [key, value] of Object.entries(filters)) {
            if (key.endsWith('_in')) {
              const field = key.replace('_in', '')
              if (!(value as unknown[]).includes(record[field])) {
                matches = false
                break
              }
            } else if (record[key] !== value) {
              matches = false
              break
            }
          }
          if (matches) {
            results.push(record)
          }
        }

        return resolve({ data: results, error: null })
      },
    }

    return builder
  }

  return {
    from: (tableName: string) => createQueryBuilder(tableName),
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: testDataStore.users.values().next().value || null },
        error: null,
      }),
      signInWithPassword: vi.fn().mockImplementation(({ email }) => {
        for (const user of testDataStore.users.values()) {
          if (user.email === email) {
            return Promise.resolve({ data: { user }, error: null })
          }
        }
        return Promise.resolve({ data: { user: null }, error: { message: 'Invalid credentials' } })
      }),
      signUp: vi.fn().mockImplementation(({ email }) => {
        const id = crypto.randomUUID()
        const user: TestUser = { id, email, organization_id: '' }
        testDataStore.users.set(id, user)
        return Promise.resolve({ data: { user }, error: null })
      }),
      signOut: vi.fn().mockResolvedValue({ error: null }),
    },
    rpc: vi.fn().mockImplementation((fnName: string, params: Record<string, unknown>) => {
      // Handle RPC calls
      if (fnName === 'increment_campaign_replies') {
        const campaign = testDataStore.campaigns.get(params.p_campaign_id as string)
        if (campaign && campaign.stats) {
          const stats = campaign.stats as Record<string, number>
          stats.replied = (stats.replied || 0) + 1
        }
        return Promise.resolve({ data: null, error: null })
      }
      return Promise.resolve({ data: null, error: null })
    }),
  }
}

// ============================================================================
// Test Lifecycle Hooks
// ============================================================================

let mockSupabase: ReturnType<typeof createE2ESupabaseClient>

beforeAll(() => {
  mockSupabase = createE2ESupabaseClient()
})

beforeEach(() => {
  clearTestDataStore()
  mockSupabase = createE2ESupabaseClient()
})

afterEach(() => {
  vi.clearAllMocks()
})

afterAll(() => {
  clearTestDataStore()
})

// ============================================================================
// Mock Module Overrides for E2E Tests
// ============================================================================

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => mockSupabase,
}))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => mockSupabase,
}))

// ============================================================================
// Exports
// ============================================================================

export { mockSupabase }
