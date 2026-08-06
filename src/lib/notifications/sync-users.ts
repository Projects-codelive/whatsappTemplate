/**
 * Triggers a server-side synchronization of the Niveshbay Users API
 * into the local Supabase `users` table. The page never talks to the
 * upstream API directly — it reads only from Supabase.
 */
export async function syncUsers(): Promise<number> {
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

  return synchronized
}
