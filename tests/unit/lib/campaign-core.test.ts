import { describe, expect, it } from 'vitest'
import { campaignInput, sequenceInput, sequenceFromRow, campaignFromRow } from '@/lib/campaigns/core'

describe('campaign core trust boundaries', () => {
  it('rejects caller-supplied tenant and status', () => {
    expect(() => campaignInput.parse({ name: 'Offer', organizationId: 'other' })).toThrow()
    expect(() => campaignInput.parse({ name: 'Offer', status: 'active' })).toThrow()
  })
  it('rejects tracking claims while the plain-text transport has no tracker', () => {
    expect(() => campaignInput.parse({ name: 'Offer', settings: { trackOpens: true } })).toThrow()
    expect(() => campaignInput.parse({ name: 'Offer', settings: { trackClicks: true } })).toThrow()
  })

  it('accepts provider mailbox IDs rather than requiring invented UUID accounts', () => {
    expect(campaignInput.parse({ name: 'Offer', mailboxIds: ['winnr-mailbox-42'] }).mailboxIds).toEqual(['winnr-mailbox-42'])
  })
  it('rejects invalid schedule configuration and unsupported variants', () => {
    expect(() => campaignInput.parse({ name: 'Offer', settings: { timezone: 'Invalid/Zone' } })).toThrow()
    expect(() => sequenceInput.parse({ expectedUpdatedAt: '2026-10-05T00:00:00Z', steps: [{
      id: 'step', order: 1, type: 'email', delayDays: 0, delayHours: 0, condition: 'always',
      variants: [variant, { ...variant, id: 'b' }],
    }] })).toThrow()
  })
  it('retains plain text and HTML independently when loading a sequence', () => {
    const step = sequenceFromRow({ id: 's', step_number: 1, subject: 'Hello', body_html: '<p>Hello</p>', body_text: 'Hello plain', delay_days: 0, delay_hours: 0, condition_type: 'always' })
    expect(step.variants[0].body).toBe('<p>Hello</p>')
    expect(step.variants[0].bodyText).toBe('Hello plain')
    expect(sequenceFromRow({ id: 's', step_number: 1, subject: 'Hello', body_html: '', body_text: 'Text only', delay_days: 0, delay_hours: 0, condition_type: 'always' }).variants[0].body).toBe('Text only')
  })
  it('preserves legacy schedule settings and marks absent delivery evidence unknown', () => {
    const c = campaignFromRow({ id: 'c', organization_id: 'o', name: 'Offer', status: 'draft', settings: { daily_limit: 73, send_hours_start: 10, send_hours_end: 16, send_days: ['mon', 'wed'] }, stats: {}, created_at: 'created', updated_at: 'revision' })
    expect(c.settings.dailyLimit).toBe(73)
    expect(c.settings.sendingWindowStart).toBe(10)
    expect(c.settings.sendingWindowEnd).toBe(16)
    expect(c.settings.sendingDays).toEqual([1, 3])
    expect(c.stats).toBeNull()
    const partial = campaignFromRow({ id: 'c', organization_id: 'o', name: 'Offer', status: 'draft', settings: {}, stats: { sent: 12, opened: 3 }, created_at: 'created', updated_at: 'revision' })
    expect(partial.stats).toBeNull()
    expect(partial.storedStats).toEqual({ sent: 12, opened: 3 })
  })

  it('maps actual campaign columns to the camelCase UI contract', () => {
    const c = campaignFromRow({ id: 'c', organization_id: 'o', name: 'Offer', status: 'draft', settings: { mailboxIds: ['provider-id'] }, stats: {}, created_at: 'created', updated_at: 'revision' })
    expect(c.mailboxIds).toEqual(['provider-id'])
    expect(c.createdAt).toBe('created')
    expect(c.updatedAt).toBe('revision')
  })
})
const variant = { id: 'a', name: 'A', weight: 100, subject: 'Hello', body: 'Hello', isPlainText: true }
