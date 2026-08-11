import type { NotificationPayload } from '@/types'
import { isNotificationCategory } from './categories'

/**
 * Server-side validation for the push-notification send route. Extracted
 * from the route handler so it is unit-testable without a Supabase/Firebase
 * round-trip. Title and message stay required; imageUrl is optional and,
 * when present, must be an http(s) URL.
 */

export interface SendNotificationRequestBody {
  target?: unknown
  userIds?: unknown
  category?: unknown
  title?: unknown
  message?: unknown
  imageUrl?: unknown
}

export type ValidationResult =
  | { ok: true; payload: NotificationPayload }
  | { ok: false; error: string; status: number }

export function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export function validateSendRequest(body: SendNotificationRequestBody): ValidationResult {
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  const message = typeof body.message === 'string' ? body.message.trim() : ''

  if (!title) {
    return { ok: false, error: 'Notification title is required', status: 400 }
  }
  if (!message) {
    return { ok: false, error: 'Notification message is required', status: 400 }
  }

  const rawImageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : ''
  let imageUrl: string | undefined
  if (rawImageUrl) {
    if (!isHttpUrl(rawImageUrl)) {
      return {
        ok: false,
        error: 'Notification image must be a valid http(s) URL',
        status: 400,
      }
    }
    imageUrl = rawImageUrl
  }

  if (body.target === 'selected') {
    const userIds = Array.isArray(body.userIds)
      ? body.userIds.filter(
          (id): id is string => typeof id === 'string' && id.length > 0,
        )
      : []
    if (userIds.length === 0) {
      return { ok: false, error: 'Select at least one user', status: 400 }
    }
    return {
      ok: true,
      payload: { target: 'selected', userIds, title, message, imageUrl },
    }
  }

  if (body.target === 'all') {
    return { ok: true, payload: { target: 'all', title, message, imageUrl } }
  }

  if (body.target === 'category') {
    const category = typeof body.category === 'string' ? body.category.trim() : ''
    if (!category) {
      return { ok: false, error: 'Select a category', status: 400 }
    }
    if (!isNotificationCategory(category)) {
      return { ok: false, error: 'Invalid notification category', status: 400 }
    }
    return {
      ok: true,
      payload: { target: 'category', category, title, message, imageUrl },
    }
  }

  return { ok: false, error: 'Invalid notification target', status: 400 }
}
