import { describe, expect, it } from 'vitest'
import type { NotificationUser, SyncUsersResult } from '@/types'
import {
  DEFAULT_PAGE_SIZE,
  describeSendTarget,
  filterUsers,
  hasActiveFilters,
  matchesCategory,
  matchesSearch,
  paginateUsers,
  summarizeSyncResult,
  summarizeUsers,
  toggleIds,
} from './user-list'

function user(overrides: Partial<NotificationUser> & { id: string }): NotificationUser {
  return {
    name: null,
    mobile: null,
    email: null,
    category: null,
    fcm_token: null,
    created_at: '2024-01-01T00:00:00Z',
    joined_at: null,
    ...overrides,
  }
}

const USERS: NotificationUser[] = [
  user({ id: 'a', name: 'Alice', mobile: '9800000001', email: 'alice@example.com', category: 'Free', fcm_token: 'tok-a' }),
  user({ id: 'b', name: 'Bob', mobile: '9800000002', email: 'bob@example.com', category: 'Premium', fcm_token: 'tok-b' }),
  user({ id: 'c', name: 'Carol', mobile: '9800000003', email: 'carol@example.com', category: 'Paid', fcm_token: null }),
  user({ id: 'd', name: 'Dave', mobile: '9800000004', email: 'dave@example.com', category: 'Premium Expired' }),
  user({ id: 'e', name: 'Erin', mobile: '9800000005', email: 'erin@example.com', category: 'Free Expired', fcm_token: 'tok-e' }),
]

describe('hasActiveFilters', () => {
  it('is false for the default state', () => {
    expect(hasActiveFilters({ search: '', category: 'all' })).toBe(false)
    expect(hasActiveFilters({ search: '   ', category: 'all' })).toBe(false)
  })

  it('is true when search or category deviate', () => {
    expect(hasActiveFilters({ search: 'a', category: 'all' })).toBe(true)
    expect(hasActiveFilters({ search: '', category: 'Free' })).toBe(true)
  })
})

describe('matchesSearch', () => {
  it('matches name, mobile, and email case-insensitively', () => {
    expect(matchesSearch(USERS[0], 'ali')).toBe(true)
    expect(matchesSearch(USERS[0], 'ALICE')).toBe(true)
    expect(matchesSearch(USERS[0], '9800000001')).toBe(true)
    expect(matchesSearch(USERS[0], 'ALICE@EXAMPLE.COM')).toBe(true)
  })

  it('matches everything for an empty query', () => {
    expect(matchesSearch(USERS[0], '')).toBe(true)
    expect(matchesSearch(USERS[0], '   ')).toBe(true)
  })

  it('does not match unrelated text', () => {
    expect(matchesSearch(USERS[0], 'zzz')).toBe(false)
  })
})

describe('matchesCategory', () => {
  it('matches everything when category is all', () => {
    expect(matchesCategory(USERS[0], 'all')).toBe(true)
  })

  it('expands Premium to reach both Premium and Paid rows', () => {
    expect(matchesCategory(USERS[1], 'Premium')).toBe(true)
    expect(matchesCategory(USERS[2], 'Premium')).toBe(true)
    expect(matchesCategory(USERS[0], 'Premium')).toBe(false)
  })

  it('keeps every other category an exact match', () => {
    expect(matchesCategory(USERS[0], 'Free')).toBe(true)
    expect(matchesCategory(USERS[1], 'Free')).toBe(false)
    expect(matchesCategory(USERS[3], 'Premium Expired')).toBe(true)
  })
})

describe('filterUsers', () => {
  it('combines search and category', () => {
    const result = filterUsers(USERS, { search: 'ali', category: 'Free' })
    expect(result.map((u) => u.id)).toEqual(['a'])
  })

  it('returns an empty list when nothing matches (empty state)', () => {
    expect(filterUsers(USERS, { search: 'zzz', category: 'all' })).toEqual([])
    expect(filterUsers(USERS, { search: '', category: 'Free' })).toHaveLength(1)
  })

  it('returns all users when no filters are active', () => {
    expect(filterUsers(USERS, { search: '', category: 'all' })).toEqual(USERS)
  })
})

describe('paginateUsers', () => {
  const many = Array.from({ length: 60 }, (_, i) => user({ id: `u${i}` }))

  it('slices the first page', () => {
    const page = paginateUsers(many, 1, 25)
    expect(page.items).toHaveLength(25)
    expect(page.totalPages).toBe(3)
    expect(page.page).toBe(1)
    expect(page.startIndex).toBe(0)
    expect(page.endIndex).toBe(25)
    expect(page.pageSize).toBe(25)
  })

  it('slices the last, partial page', () => {
    const page = paginateUsers(many, 3, 25)
    expect(page.items).toHaveLength(10)
    expect(page.startIndex).toBe(50)
    expect(page.endIndex).toBe(60)
  })

  it('clamps an out-of-range page to the last page', () => {
    const page = paginateUsers(many, 99, 25)
    expect(page.page).toBe(3)
    expect(page.items).toHaveLength(10)
  })

  it('clamps page 0 and negative pages to page 1', () => {
    expect(paginateUsers(many, 0, 25).page).toBe(1)
    expect(paginateUsers(many, -3, 25).page).toBe(1)
  })

  it('falls back to the default page size for unsupported sizes', () => {
    const page = paginateUsers(many, 1, 10)
    expect(page.pageSize).toBe(DEFAULT_PAGE_SIZE)
    expect(page.items).toHaveLength(25)
  })

  it('returns an empty, single-page result for an empty list', () => {
    const page = paginateUsers([], 1, 25)
    expect(page.items).toEqual([])
    expect(page.totalPages).toBe(1)
    expect(page.startIndex).toBe(0)
    expect(page.endIndex).toBe(0)
  })
})

describe('toggleIds', () => {
  it('adds ids without mutating the input set', () => {
    const selected = new Set(['a'])
    const next = toggleIds(selected, ['b', 'c'], true)
    expect(next).toEqual(new Set(['a', 'b', 'c']))
    expect(selected).toEqual(new Set(['a']))
  })

  it('removes ids', () => {
    const next = toggleIds(new Set(['a', 'b', 'c']), ['a', 'c'], false)
    expect(next).toEqual(new Set(['b']))
  })

  it('keeps page selection and filtered selection independent', () => {
    const filteredIds = ['a', 'b', 'c', 'd', 'e']
    const pageIds = filteredIds.slice(0, 2)
    const selected = toggleIds(new Set(), pageIds, true)
    expect([...selected]).toEqual(['a', 'b'])
    const all = toggleIds(selected, filteredIds, true)
    expect(all.size).toBe(5)
    const backToPage = toggleIds(all, pageIds, false)
    expect([...backToPage].sort()).toEqual(['c', 'd', 'e'])
  })
})

describe('summarizeUsers', () => {
  it('counts total, selected, FCM ready, and missing FCM', () => {
    const summary = summarizeUsers(USERS, new Set(['a', 'b', 'x']))
    expect(summary.total).toBe(5)
    expect(summary.selected).toBe(2)
    expect(summary.fcmReady).toBe(3)
    expect(summary.missingFcm).toBe(2)
  })
})

describe('describeSendTarget', () => {
  it('pluralizes the selected-user count', () => {
    expect(describeSendTarget({ target: 'selected', selectedCount: 1, category: null })).toBe(
      'Sending to 1 selected user.',
    )
    expect(describeSendTarget({ target: 'selected', selectedCount: 3, category: null })).toBe(
      'Sending to 3 selected users.',
    )
  })

  it('warns before broadcasting to all users', () => {
    expect(describeSendTarget({ target: 'all', selectedCount: 0, category: null })).toContain(
      'ALL users',
    )
    expect(describeSendTarget({ target: 'all', selectedCount: 0, category: null })).toContain(
      'cannot be easily undone',
    )
  })

  it('mentions Paid users for the Premium category target', () => {
    const text = describeSendTarget({ target: 'category', selectedCount: 0, category: 'Premium' })
    expect(text).toContain('Premium')
    expect(text).toContain('Paid')
  })

  it('does not add expansion text for other categories', () => {
    const text = describeSendTarget({ target: 'category', selectedCount: 0, category: 'Free' })
    expect(text).toContain('Free')
    expect(text).not.toContain('includes')
  })
})

describe('summarizeSyncResult', () => {
  const base: SyncUsersResult = {
    success: true,
    synchronized: 12,
    checkedForFcm: 0,
    tokensUpdated: 0,
    tokenFetchFailed: 0,
    typesChecked: 0,
    categoriesUpdated: 0,
    typeFetchFailed: 0,
  }

  it('returns the success text when only the user import ran', () => {
    expect(summarizeSyncResult(base)).toBe('Users synchronized successfully.')
  })

  it('appends FCM and type-refresh details when they ran', () => {
    const result: SyncUsersResult = {
      ...base,
      checkedForFcm: 4,
      tokensUpdated: 3,
      tokenFetchFailed: 1,
      typesChecked: 6,
      categoriesUpdated: 5,
      typeFetchFailed: 1,
    }
    const text = summarizeSyncResult(result)
    expect(text).toContain('Users synchronized: 12')
    expect(text).toContain('tokens updated: 3')
    expect(text).toContain('token fetches failed: 1')
    expect(text).toContain('categories updated: 5')
    expect(text).toContain('type fetches failed: 1')
  })
})
