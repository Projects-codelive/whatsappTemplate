import { describe, expect, it } from 'vitest'
import {
  getCampaignStatus,
  getNotificationRecipientStatus,
} from './notification-status'

describe('getCampaignStatus', () => {
  it('returns correct label and classes for sending', () => {
    const result = getCampaignStatus('sending')
    expect(result.label).toBe('Sending')
    expect(result.pulse).toBe(true)
    expect(result.classes).toContain('yellow')
  })

  it('returns correct label for sent', () => {
    const result = getCampaignStatus('sent')
    expect(result.label).toBe('Sent')
    expect(result.pulse).toBeUndefined()
  })

  it('returns correct label for failed', () => {
    const result = getCampaignStatus('failed')
    expect(result.label).toBe('Failed')
  })

  it('falls back to sending for unknown status', () => {
    const result = getCampaignStatus('unknown')
    expect(result.label).toBe('Sending')
  })
})

describe('getNotificationRecipientStatus', () => {
  it('returns correct label for pending', () => {
    const result = getNotificationRecipientStatus('pending')
    expect(result.label).toBe('Pending')
  })

  it('returns correct label for sent', () => {
    const result = getNotificationRecipientStatus('sent')
    expect(result.label).toBe('Sent')
  })

  it('returns correct label for failed', () => {
    const result = getNotificationRecipientStatus('failed')
    expect(result.label).toBe('Failed')
  })

  it('returns correct label for skipped', () => {
    const result = getNotificationRecipientStatus('skipped')
    expect(result.label).toBe('Skipped')
    expect(result.classes).toContain('amber')
  })

  it('falls back to pending for unknown status', () => {
    const result = getNotificationRecipientStatus('bogus')
    expect(result.label).toBe('Pending')
  })
})
