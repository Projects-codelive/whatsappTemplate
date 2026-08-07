/**
 * Canonical notification categories.
 *
 * These are the ONLY categories the Notifications module uses — the toolbar
 * filter dropdown, the "Category" target in the send modal, the send API
 * validation, and the users-sync mapping all read from here so a category
 * is defined once instead of being hardcoded in five places.
 */

export const NOTIFICATION_CATEGORIES = [
  'Free',
  'Free Expired',
  'No Trader',
  'Premium',
  'Premium Expired',
  'Day Pass',
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** Lowercased alias → canonical category. The Niveshbay API returns
 *  `user_type` values in varying case ("free", "Free Expired", …), so the
 *  sync route normalizes through this map before writing to Supabase. */
export const NOTIFICATION_CATEGORY_ALIASES: Record<string, NotificationCategory> = {
  free: 'Free',
  'free expired': 'Free Expired',
  'no trader': 'No Trader',
  premium: 'Premium',
  'premium expired': 'Premium Expired',
  'day pass': 'Day Pass',
};

export function isNotificationCategory(value: string): value is NotificationCategory {
  return (NOTIFICATION_CATEGORIES as readonly string[]).includes(value);
}

/** Category → the stored categories it must also match. The backend now
 *  returns `Paid` for users that previously came in as `Premium`, and
 *  existing `Premium` rows are not migrated, so selecting "Premium" has to
 *  reach both values. Every other category expands to itself. */
const CATEGORY_GROUPS: Record<string, string[]> = {
  Premium: ['Premium', 'Paid'],
};

/** Expands a selected category into the full set of stored categories it
 *  matches. Single source of truth for Premium/Paid compatibility — the
 *  Notification page filter and the send API both resolve recipients
 *  through this, so the OR condition is never duplicated. */
export function expandNotificationCategory(category: string): string[] {
  return CATEGORY_GROUPS[category] ?? [category];
}
