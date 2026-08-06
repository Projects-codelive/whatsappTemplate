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
};

export function isNotificationCategory(value: string): value is NotificationCategory {
  return (NOTIFICATION_CATEGORIES as readonly string[]).includes(value);
}
