import type {
  NotificationTarget,
  NotificationUser,
  SyncUsersResult,
} from '@/types'
import { expandNotificationCategory } from './categories'

/** Page sizes offered by the users table pagination control. */
export const PAGE_SIZE_OPTIONS = [25, 50, 100] as const
export type PageSize = (typeof PAGE_SIZE_OPTIONS)[number]
export const DEFAULT_PAGE_SIZE: PageSize = 25

/** Search + category state that narrows the user list. */
export interface UserFilter {
  search: string
  category: string
}

/** True when the search box or the category dropdown deviate from their
 *  defaults — drives the "Clear filters" affordances. */
export function hasActiveFilters(filter: UserFilter): boolean {
  return filter.search.trim() !== '' || filter.category !== 'all'
}

export function matchesSearch(user: NotificationUser, search: string): boolean {
  const query = search.trim().toLowerCase()
  if (query === '') return true
  return (
    (user.name ?? '').toLowerCase().includes(query) ||
    (user.mobile ?? '').toLowerCase().includes(query) ||
    (user.email ?? '').toLowerCase().includes(query)
  )
}

export function matchesCategory(user: NotificationUser, category: string): boolean {
  if (category === 'all') return true
  return expandNotificationCategory(category).includes(user.category ?? '')
}

export function filterUsers(
  users: readonly NotificationUser[],
  filter: UserFilter,
): NotificationUser[] {
  return users.filter(
    (user) => matchesSearch(user, filter.search) && matchesCategory(user, filter.category),
  )
}

export interface Paginated<T> {
  items: T[]
  page: number
  pageSize: number
  totalItems: number
  totalPages: number
  /** 0-based index of the first item on the current page. */
  startIndex: number
  /** 0-based index one past the last item on the current page. */
  endIndex: number
}

/** Slices `users` for the requested 1-based page. Clamps `page` into the
 *  valid range and falls back to `DEFAULT_PAGE_SIZE` for unsupported sizes,
 *  so a stale page state after filtering can never render an empty view. */
export function paginateUsers<T>(
  users: readonly T[],
  page: number,
  pageSize: number,
): Paginated<T> {
  const safeSize = PAGE_SIZE_OPTIONS.includes(pageSize as PageSize)
    ? (pageSize as PageSize)
    : DEFAULT_PAGE_SIZE
  const totalPages = Math.max(1, Math.ceil(users.length / safeSize))
  const safePage = Math.min(Math.max(1, Math.floor(page) || 1), totalPages)
  const startIndex = (safePage - 1) * safeSize
  const endIndex = Math.min(startIndex + safeSize, users.length)
  return {
    items: users.slice(startIndex, endIndex),
    page: safePage,
    pageSize: safeSize,
    totalItems: users.length,
    totalPages,
    startIndex,
    endIndex,
  }
}

/** Adds or removes `ids` from the selection set without mutating it. */
export function toggleIds(
  selected: ReadonlySet<string>,
  ids: Iterable<string>,
  checked: boolean,
): Set<string> {
  const next = new Set(selected)
  for (const id of ids) {
    if (checked) next.add(id)
    else next.delete(id)
  }
  return next
}

export interface UserSummary {
  total: number
  selected: number
  fcmReady: number
  missingFcm: number
}

/** Counts that drive the summary strip and the selection toolbar. `users`
 *  is the already-filtered list, so `selected` only counts rows that are
 *  visible in the current filter. */
export function summarizeUsers(
  users: readonly NotificationUser[],
  selectedIds: ReadonlySet<string>,
): UserSummary {
  const fcmReady = users.filter((user) => Boolean(user.fcm_token)).length
  const selected = users.filter((user) => selectedIds.has(user.id)).length
  return {
    total: users.length,
    selected,
    fcmReady,
    missingFcm: users.length - fcmReady,
  }
}

/** Human-readable confirmation line for the send modal, describing who the
 *  current target resolves to. Premium also reaches legacy "Paid" rows, so
 *  the category target mentions that explicitly. */
export function describeSendTarget(input: {
  target: NotificationTarget
  selectedCount: number
  category: string | null
}): string {
  switch (input.target) {
    case 'selected':
      return `Sending to ${input.selectedCount} selected user${input.selectedCount === 1 ? '' : 's'}.`
    case 'all':
      return 'Sending to ALL users. This cannot be easily undone.'
    case 'category': {
      const base = `Sending to all users in "${input.category}".`
      if (!input.category) return base
      const expanded = expandNotificationCategory(input.category)
      const extra = expanded.filter((c) => c !== input.category)
      return extra.length > 0
        ? `${base} This also includes ${extra.join(' and ')} users.`
        : base
    }
  }
}

/** One-line summary of a sync run, shown after Sync Users finishes. */
export function summarizeSyncResult(result: SyncUsersResult): string {
  const parts = [`Users synchronized: ${result.synchronized}`]
  if (result.checkedForFcm > 0) {
    parts.push(
      `tokens updated: ${result.tokensUpdated}, token fetches failed: ${result.tokenFetchFailed}`,
    )
  }
  if (result.typesChecked > 0) {
    parts.push(
      `categories updated: ${result.categoriesUpdated}, type fetches failed: ${result.typeFetchFailed}`,
    )
  }
  return parts.length > 1 ? parts.join(' — ') : 'Users synchronized successfully.'
}
