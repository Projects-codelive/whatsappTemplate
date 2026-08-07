import type { SyncUsersResult } from '@/types'

/**
 * Triggers a server-side synchronization of the Niveshbay Users API
 * into the local Supabase `users` table, then backfills FCM tokens for
 * users that were missing one. The page never talks to the upstream API
 * directly — it reads only from Supabase.
 */
export async function syncUsers(): Promise<SyncUsersResult> {
  let res: Response
  try {
    res = await fetch('/api/users/sync', { method: 'POST' })
  } catch {
    throw new Error('Network error while synchronizing users')
  }

  const json = await res.json().catch(() => null)

  if (!res.ok) {
    throw new Error(
      typeof json?.error === 'string' ? json.error : 'Failed to synchronize users',
    )
  }

  const synchronized = typeof json?.synchronized === 'number' ? json.synchronized : 0
  if (synchronized === 0) {
    throw new Error('Users API returned no users to synchronize')
  }

  return {
    success: json?.success === true,
    synchronized,
    checkedForFcm: typeof json?.checkedForFcm === 'number' ? json.checkedForFcm : 0,
    tokensUpdated: typeof json?.tokensUpdated === 'number' ? json.tokensUpdated : 0,
    tokenFetchFailed: typeof json?.tokenFetchFailed === 'number' ? json.tokenFetchFailed : 0,
    typesChecked: typeof json?.typesChecked === 'number' ? json.typesChecked : 0,
    categoriesUpdated: typeof json?.categoriesUpdated === 'number' ? json.categoriesUpdated : 0,
    typeFetchFailed: typeof json?.typeFetchFailed === 'number' ? json.typeFetchFailed : 0,
  }
}
