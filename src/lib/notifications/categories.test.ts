import { describe, expect, it } from 'vitest'
import { expandNotificationCategory } from './categories'

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
