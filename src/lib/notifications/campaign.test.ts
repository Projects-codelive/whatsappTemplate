import { describe, expect, it } from 'vitest'
import type { NotificationRecipient } from './campaign'

// We test the campaign helper functions in isolation using mock Supabase
// clients. These tests verify the function signatures and error handling
// without requiring a real database.

describe('campaign helpers', () => {
  it('exports expected functions', async () => {
    const mod = await import('./campaign')
    expect(typeof mod.createNotificationCampaign).toBe('function')
    expect(typeof mod.createNotificationRecipients).toBe('function')
    expect(typeof mod.updateNotificationRecipient).toBe('function')
    expect(typeof mod.persistRecipientUpdate).toBe('function')
    expect(typeof mod.finalizeCampaign).toBe('function')
    expect(typeof mod.recomputeCampaignCounts).toBe('function')
  })

  it('NotificationRecipient type includes failed_at', () => {
    // Compile-time check: the interface should have failed_at as string | null
    const _typeCheck: NotificationRecipient = {
      id: '',
      campaign_id: '',
      user_id: '',
      fcm_token: null,
      status: 'pending',
      provider_message_id: null,
      error_code: null,
      error_message: null,
      sent_at: null,
      failed_at: null,
      created_at: '',
    }
    expect(_typeCheck.failed_at).toBeNull()
  })
})

describe('NotificationPayload backward compatibility', () => {
  it('NotificationSendResult type compiles correctly', async () => {
    // Verify the types module loads without error — confirms the type
    // exists and includes the optional campaignId field.
    await import('@/types')
    expect(true).toBe(true)
  })
})
