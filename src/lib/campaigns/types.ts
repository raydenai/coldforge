// Campaign Types

export interface Campaign {
  id: string
  organizationId: string
  name: string
  status: CampaignStatus
  type: CampaignType
  settings: CampaignSettings
  stats: CampaignStats
  leadListIds: string[]
  mailboxIds: string[]
  scheduleId?: string
  createdAt: string
  updatedAt: string
  startedAt?: string
  pausedAt?: string
  completedAt?: string
}

export type CampaignStatus =
  | 'draft'
  | 'active'
  | 'paused'
  | 'completed'
  | 'archived'

export type CampaignType =
  | 'cold_email'
  | 'follow_up'
  | 'nurture'
  | 'announcement'

export interface CampaignSettings {
  dailyLimit: number
  sendingWindowStart: number
  sendingWindowEnd: number
  timezone: string
  skipWeekends: boolean
  trackOpens: boolean
  trackClicks: boolean
  unsubscribeLink: boolean
  stopOnReply: boolean
  stopOnBounce: boolean
  abTestEnabled: boolean
  abTestWinnerCriteria?: 'open_rate' | 'reply_rate' | 'click_rate'
  abTestDuration?: number // hours
}

export interface CampaignStats {
  totalLeads: number
  contacted: number
  opened: number
  clicked: number
  replied: number
  bounced: number
  unsubscribed: number
  openRate: number
  clickRate: number
  replyRate: number
  bounceRate: number
}

export interface CampaignSequence {
  id: string
  campaignId: string
  steps: SequenceStep[]
  createdAt: string
  updatedAt: string
}

export interface SequenceStep {
  id: string
  order: number
  type: StepType
  delayDays: number
  delayHours: number
  condition?: StepCondition
  variants: EmailVariant[]
}

export type StepType =
  | 'email'
  | 'wait'
  | 'condition'

export interface StepCondition {
  type: 'opened' | 'clicked' | 'replied' | 'not_opened' | 'not_clicked' | 'not_replied'
  stepId?: string
}

export interface EmailVariant {
  id: string
  name: string
  weight: number // Percentage for A/B testing (0-100)
  subject: string
  body: string
  isPlainText: boolean
  bodyText?: string | null
  stats?: VariantStats
}

export interface VariantStats {
  sent: number
  opened: number
  clicked: number
  replied: number
  openRate: number
  clickRate: number
  replyRate: number
}

// Template Variables
export interface TemplateVariable {
  name: string
  key: string
  description: string
  example: string
  category: VariableCategory
}

export type VariableCategory =
  | 'lead'
  | 'company'
  | 'sender'
  | 'custom'
  | 'dynamic'

export const BUILT_IN_VARIABLES: TemplateVariable[] = [
  // Lead variables
  { name: 'First Name', key: '{{firstName}}', description: 'Lead first name', example: 'John', category: 'lead' },
  { name: 'Last Name', key: '{{lastName}}', description: 'Lead last name', example: 'Doe', category: 'lead' },
  { name: 'Full Name', key: '{{fullName}}', description: 'Lead full name', example: 'John Doe', category: 'lead' },
  { name: 'Email', key: '{{email}}', description: 'Lead email address', example: 'john@example.com', category: 'lead' },
  { name: 'Title', key: '{{title}}', description: 'Lead job title', example: 'CEO', category: 'lead' },
  { name: 'Phone', key: '{{phone}}', description: 'Lead phone number', example: '+1234567890', category: 'lead' },

  // Company variables
  { name: 'Company', key: '{{company}}', description: 'Lead company name', example: 'Acme Inc', category: 'company' },
  { name: 'Website', key: '{{website}}', description: 'Company website', example: 'acme.com', category: 'company' },
  { name: 'Industry', key: '{{industry}}', description: 'Company industry', example: 'Technology', category: 'company' },

  // Sender variables
  { name: 'Sender Name', key: '{{senderName}}', description: 'Your name', example: 'Jane Smith', category: 'sender' },
  { name: 'Sender Email', key: '{{senderEmail}}', description: 'Your email', example: 'jane@company.com', category: 'sender' },
  { name: 'Sender Title', key: '{{senderTitle}}', description: 'Your job title', example: 'Sales Rep', category: 'sender' },
  { name: 'Sender Company', key: '{{senderCompany}}', description: 'Your company', example: 'Company Inc', category: 'sender' },
  { name: 'Sender Phone', key: '{{senderPhone}}', description: 'Your phone', example: '+1987654321', category: 'sender' },

  // Dynamic variables
  { name: 'Current Day', key: '{{day}}', description: 'Current day name', example: 'Monday', category: 'dynamic' },
  { name: 'Current Month', key: '{{month}}', description: 'Current month name', example: 'January', category: 'dynamic' },
  { name: 'Current Year', key: '{{year}}', description: 'Current year', example: '2025', category: 'dynamic' },
]

// Default campaign settings
export const DEFAULT_CAMPAIGN_SETTINGS: CampaignSettings = {
  dailyLimit: 50,
  sendingWindowStart: 9,
  sendingWindowEnd: 17,
  timezone: 'America/New_York',
  skipWeekends: true,
  trackOpens: false,
  trackClicks: false,
  unsubscribeLink: true,
  stopOnReply: true,
  stopOnBounce: true,
  abTestEnabled: false,
}

// Initial campaign stats
export const INITIAL_CAMPAIGN_STATS: CampaignStats = {
  totalLeads: 0,
  contacted: 0,
  opened: 0,
  clicked: 0,
  replied: 0,
  bounced: 0,
  unsubscribed: 0,
  openRate: 0,
  clickRate: 0,
  replyRate: 0,
  bounceRate: 0,
}

// Helper functions
export function calculateStats(
  contacted: number,
  opened: number,
  clicked: number,
  replied: number,
  bounced: number
): Pick<CampaignStats, 'openRate' | 'clickRate' | 'replyRate' | 'bounceRate'> {
  return {
    openRate: contacted > 0 ? Math.round((opened / contacted) * 100 * 10) / 10 : 0,
    clickRate: contacted > 0 ? Math.round((clicked / contacted) * 100 * 10) / 10 : 0,
    replyRate: contacted > 0 ? Math.round((replied / contacted) * 100 * 10) / 10 : 0,
    bounceRate: contacted > 0 ? Math.round((bounced / contacted) * 100 * 10) / 10 : 0,
  }
}

export function generateVariantId(): string {
  return `var_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}

export function generateStepId(): string {
  return `step_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}
