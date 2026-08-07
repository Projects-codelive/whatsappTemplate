import type { SupabaseClient } from '@supabase/supabase-js'
import { NIVESHBAY_API_KEY, NIVESHBAY_USER_API_URL } from './niveshbay-api'

/**
 * Backfills missing FCM tokens for locally synced users.
 *
 * Runs AFTER the Users API sync: for every user whose `fcm_token` is
 * NULL or empty, a single POST to the User API (user.php) resolves the
 * latest token by `mobile`, and the local Supabase row is updated with
 * ONLY the token — name/email/mobile/category/joined_at are untouched.
 *
 * Failures never abort the sync: each user is attempted independently,
 * failures are logged, and the counts are returned for the "Sync Users"
 * response. Users that already have a valid token are never queried here
 * — the caller only passes users with missing tokens.
 */

/** Small concurrency cap so we never overload the upstream API. */
const CONCURRENCY = 5
/** Node's `fetch` never times out on its own; a hung API would otherwise
 *  stall the whole sync until the platform kills it. */
const REQUEST_TIMEOUT_MS = 10_000

export interface MissingTokenUser {
  id: string
  mobile: string | null
}

export interface FcmBackfillResult {
  /** Users checked against the User API (tokensUpdated + tokenFetchFailed). */
  checkedForFcm: number
  tokensUpdated: number
  tokenFetchFailed: number
}

interface UserApiResponse {
  status?: unknown
  message?: unknown
  data?: {
    fcm_token?: string | null
    [key: string]: unknown
  } | null
}

/**
 * Fetches the latest FCM token for a single mobile number. Throws on
 * network failure, non-2xx, malformed body, `status=false`, or a missing
 * token so the caller decides how to count the outcome.
 */
export async function fetchUserFcmToken(mobile: string): Promise<string> {
  let res: Response
  try {
    res = await fetch(NIVESHBAY_USER_API_URL, {
      method: 'POST',
      headers: {
        'X-API-KEY': NIVESHBAY_API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ mobile }),
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new Error('Network error while fetching the FCM token')
  }

  if (!res.ok) {
    throw new Error(`FCM token API responded with HTTP ${res.status}`)
  }

  let json: UserApiResponse
  try {
    json = (await res.json()) as UserApiResponse
  } catch {
    throw new Error('FCM token API returned an invalid response')
  }

  if (json.status !== true && json.status !== 'true') {
    throw new Error(String(json.message ?? 'FCM token API returned an error'))
  }

  const token = json.data?.fcm_token?.trim()
  if (!token) {
    throw new Error('FCM token API returned no fcm_token')
  }

  return token
}

async function processUser(
  admin: Pick<SupabaseClient, 'from'>,
  user: MissingTokenUser,
): Promise<boolean> {
  const mobile = user.mobile?.trim()
  if (!mobile) {
    console.warn(
      `[users/sync] user=${user.id} has no mobile — cannot fetch an FCM token`,
    )
    return false
  }

  let token: string
  try {
    token = await fetchUserFcmToken(mobile)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error(`[users/sync] FCM token fetch failed for user=${user.id}: ${message}`)
    return false
  }

  // Update ONLY fcm_token — every other column on the row is left alone.
  const { error } = await admin
    .from('users')
    .update({ fcm_token: token })
    .eq('id', user.id)
  if (error) {
    console.error(
      `[users/sync] FCM token update failed for user=${user.id}: ${error.message}`,
    )
    return false
  }

  console.log(`[users/sync] updated FCM token for user=${user.id}`)
  return true
}

/**
 * Checks every missing-token user against the User API in small concurrent
 * batches and persists any token returned. Returns the counts needed by
 * the Sync Users response.
 */
export async function backfillMissingFcmTokens(
  admin: Pick<SupabaseClient, 'from'>,
  users: MissingTokenUser[],
): Promise<FcmBackfillResult> {
  let tokensUpdated = 0
  let tokenFetchFailed = 0

  for (let i = 0; i < users.length; i += CONCURRENCY) {
    const chunk = users.slice(i, i + CONCURRENCY)
    const outcomes = await Promise.allSettled(
      chunk.map((user) => processUser(admin, user)),
    )
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') {
        if (outcome.value) {
          tokensUpdated += 1
        } else {
          tokenFetchFailed += 1
        }
      } else {
        tokenFetchFailed += 1
        console.error('[users/sync] FCM token backfill failed:', outcome.reason)
      }
    }
  }

  return {
    checkedForFcm: users.length,
    tokensUpdated,
    tokenFetchFailed,
  }
}
