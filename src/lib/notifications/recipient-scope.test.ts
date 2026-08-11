import { describe, expect, it } from 'vitest'
import { resolveRecipientScope } from './recipient-scope'

describe('resolveRecipientScope', () => {
  it('scopes selected to the given user ids', () => {
    expect(
      resolveRecipientScope({ target: 'selected', userIds: ['a', 'b'] }),
    ).toEqual({
      column: 'id',
      values: ['a', 'b'],
    })
  })

  it('scopes all to every row', () => {
    expect(resolveRecipientScope({ target: 'all' })).toEqual({
      column: null,
      values: [],
    })
  })

  it('scopes a plain category to itself', () => {
    expect(resolveRecipientScope({ target: 'category', category: 'Free' })).toEqual({
      column: 'category',
      values: ['Free'],
    })
    expect(
      resolveRecipientScope({ target: 'category', category: 'Premium Expired' }),
    ).toEqual({
      column: 'category',
      values: ['Premium Expired'],
    })
  })

  it('expands Premium to both Premium and Paid', () => {
    expect(
      resolveRecipientScope({ target: 'category', category: 'Premium' }),
    ).toEqual({
      column: 'category',
      values: ['Premium', 'Paid'],
    })
  })
})
