import type { RecipientCountRequest, RecipientCountResponse } from '@/types'

/**
 * Fetches the exact recipient count for a target from the server route.
 * The count always reflects the same scope the send route resolves, so
 * the UI can show the real server-side recipient set (never just the rows
 * visible on the paginated page).
 */
export async function getRecipientCount(
  request: RecipientCountRequest,
): Promise<number> {
  let res: Response
  try {
    res = await fetch('/api/notifications/recipient-count', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    })
  } catch {
    throw new Error('Network error while counting recipients')
  }

  const json = await res.json().catch(() => null)

  if (!res.ok) {
    throw new Error(
      typeof json?.error === 'string' ? json.error : 'Failed to count recipients',
    )
  }

  return (json as RecipientCountResponse).count
}
