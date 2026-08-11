/**
 * Notification image constraints and validation.
 *
 * Matches the existing Supabase Storage profile-avatar pattern (2 MB, PNG /
 * JPG / WebP) so the values agree with the bucket limits already configured.
 */

export const MAX_NOTIFICATION_IMAGE_BYTES = 2 * 1024 * 1024

export const ALLOWED_NOTIFICATION_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
]) as ReadonlySet<string>

export type NotificationImageValidationResult =
  | { ok: true }
  | { ok: false; error: string }

export function validateNotificationImage(
  file: Pick<File, 'type' | 'size'>,
): NotificationImageValidationResult {
  if (!ALLOWED_NOTIFICATION_IMAGE_TYPES.has(file.type)) {
    return {
      ok: false,
      error: 'Unsupported image type. Use PNG, JPG, or WebP.',
    }
  }
  if (file.size > MAX_NOTIFICATION_IMAGE_BYTES) {
    return {
      ok: false,
      error: 'Image is too large. Maximum 2 MB.',
    }
  }
  return { ok: true }
}
