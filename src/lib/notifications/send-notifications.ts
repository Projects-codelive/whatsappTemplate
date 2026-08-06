import type { NotificationPayload, NotificationSendResult } from '@/types'

/**
 * Dispatches a push notification through the server route. The page never
 * talks to Firebase or Supabase directly for sending — it only builds the
 * payload and calls this. Mirrors syncUsers() in error handling.
 */
export async function sendNotification(
  payload: NotificationPayload,
): Promise<NotificationSendResult> {
  let res: Response
  try {
    res = await fetch('/api/notifications/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    throw new Error('Network error while sending notification')
  }

  const json = await res.json().catch(() => null)

  if (!res.ok) {
    throw new Error(
      typeof json?.error === 'string' ? json.error : 'Failed to send notification',
    )
  }

  return json as NotificationSendResult
}
