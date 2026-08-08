import { describe, expect, it } from 'vitest'
import { expandNotificationCategory, normalizeCategory } from './categories'

describe('normalizeCategory', () => {
  it('maps known user_type values to their canonical category', () => {
    expect(normalizeCategory('free')).toBe('Free')
    expect(normalizeCategory('Free')).toBe('Free')
    expect(normalizeCategory('free expired')).toBe('Free Expired')
    expect(normalizeCategory('no trader')).toBe('No Trader')
    expect(normalizeCategory('premium')).toBe('Premium')
    expect(normalizeCategory('Premium')).toBe('Premium')
    expect(normalizeCategory('premium expired')).toBe('Premium Expired')
    expect(normalizeCategory('day pass')).toBe('Day Pass')
  })

  it('maps paid to the canonical Paid category (never Premium)', () => {
    expect(normalizeCategory('paid')).toBe('Paid')
    expect(normalizeCategory('Paid')).toBe('Paid')
  })

  it('preserves the legacy capitalize-first behaviour for unknown values', () => {
    expect(normalizeCategory('platinum')).toBe('Platinum')
    expect(normalizeCategory('vip member')).toBe('Vip member')
  })

  it('returns null for blank values', () => {
    expect(normalizeCategory(null)).toBeNull()
    expect(normalizeCategory(undefined)).toBeNull()
    expect(normalizeCategory('')).toBeNull()
    expect(normalizeCategory('   ')).toBeNull()
  })
})

describe('expandNotificationCategory', () => {
  it('expands Premium to both Premium and Paid', () => {
    expect(expandNotificationCategory('Premium')).toEqual(['Premium', 'Paid'])
  })

  it('keeps every other category as an exact match', () => {
    expect(expandNotificationCategory('Free')).toEqual(['Free'])
    expect(expandNotificationCategory('Free Expired')).toEqual(['Free Expired'])
    expect(expandNotificationCategory('No Trader')).toEqual(['No Trader'])
    expect(expandNotificationCategory('Premium Expired')).toEqual(['Premium Expired'])
    expect(expandNotificationCategory('Day Pass')).toEqual(['Day Pass'])
  })
})
