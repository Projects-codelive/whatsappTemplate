import type { NotificationTarget } from '@/types'
import { expandNotificationCategory } from './categories'

/**
 * The WHERE clause a notification target applies to the `users` table.
 * Single source of truth shared by the send route and the recipient-count
 * endpoint, so the count shown in the UI always represents exactly the
 * set the send route will resolve — including the Premium →
 * ["Premium", "Paid"] expansion.
 */
export interface RecipientScope {
  /** Column to filter on. `null` means every row (the "all" target). */
  column: 'id' | 'category' | null
  /** Values for the `in` filter against `column`. */
  values: string[]
}

/** The target discriminator plus the fields a given target scopes on. */
export interface RecipientScopeInput {
  target: NotificationTarget
  userIds?: string[]
  category?: string
}

export function resolveRecipientScope(input: RecipientScopeInput): RecipientScope {
  switch (input.target) {
    case 'selected':
      return { column: 'id', values: input.userIds ?? [] }
    case 'category':
      return {
        column: 'category',
        values: expandNotificationCategory(input.category ?? ''),
      }
    case 'all':
      return { column: null, values: [] }
  }
}
