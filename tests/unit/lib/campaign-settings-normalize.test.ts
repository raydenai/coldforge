import { describe, expect, it } from 'vitest'
import { MANDATORY_DELIVERABILITY_SETTINGS, campaignFromRow, normalizeCampaignSettings, settingsInput } from '@/lib/campaigns/core'

describe('mandatory deliverability settings normalization', () => {
  it('repairs historical false safety switches to true', () => {
    const normalized = normalizeCampaignSettings({
      stopOnReply: false,
      stopOnBounce: false,
      unsubscribeLink: false,
      dailyLimit: 73,
    })
    expect(normalized.stopOnReply).toBe(true)
    expect(normalized.stopOnBounce).toBe(true)
    expect(normalized.unsubscribeLink).toBe(true)
    expect(normalized.dailyLimit).toBe(73)
  })

  it('gives a retained row a save path for an unrelated edit', () => {
    const campaign = campaignFromRow({
      id: 'c', organization_id: 'o', name: 'Legacy', status: 'active',
      settings: { stopOnReply: false, stopOnBounce: false, unsubscribeLink: false, dailyLimit: 50 },
      stats: null, created_at: 'created', updated_at: 'revision',
    })
    const payload = { ...campaign.settings, dailyLimit: 80 }
    expect(() => settingsInput.parse(payload)).not.toThrow()
    expect(settingsInput.parse(payload).dailyLimit).toBe(80)
  })

  it('still rejects a caller that tries to weaken the mandatory policy', () => {
    expect(() => settingsInput.parse({ stopOnReply: false })).toThrow()
    expect(() => settingsInput.parse({ stopOnBounce: false })).toThrow()
    expect(() => settingsInput.parse({ unsubscribeLink: false })).toThrow()
    expect(MANDATORY_DELIVERABILITY_SETTINGS).toEqual({ unsubscribeLink: true, stopOnReply: true, stopOnBounce: true })
  })
})
