import type { SupabaseClient } from '@supabase/supabase-js'
import {
  isErrorStatus,
  NIVESHBAY_API_KEY,
  NIVESHBAY_USER_TYPE_API_URL,
} from './niveshbay-api'

/**
 * Refreshes user categories from the Niveshbay User Type API.
 *
 * Runs AFTER the Users API sync and the FCM-token backfill. The User Type
 * API (user_type.php) returns every user's current `user_type`; each record
 * is matched to a local user by `mobile` and ONLY the `category` column is
 * updated. Values are stored exactly as the API returns them — unlike the
 * users.php import there is no alias normalisation here.
 *
 * Failures never abort the sync: page-level errors (timeout, network,
 * HTTP, status=false, bad JSON) are logged and stop further paging,
 * per-record errors are logged, and the counts are returned for the
 * "Sync Users" response. The already-committed upsert is never rolled back.
 */

/** Small concurrency cap so we never overload the upstream API or Supabase. */
const CONCURRENCY = 5
/** Node's `fetch` never times out on its own; a hung API would otherwise
 *  stall the whole sync until the platform kills it. */
const REQUEST_TIMEOUT_MS = 10_000
/** Guard against the API never advancing `last_user_id`. */
const MAX_PAGES = 1000

export interface UserTypeRecord {
  number?: string | null
  user_type?: string | null
}

export interface UserTypeSyncResult {
  /** Records the API returned across all pages. */
  typesChecked: number
  /** Local users whose category was updated (matched by `mobile`). */
  categoriesUpdated: number
  /** Records that could not be applied (blank number/type, no local
   *  match, Supabase error) plus pages that failed to fetch. */
  typeFetchFailed: number
}

interface UserTypeApiPage {
  status?: unknown
  message?: unknown
  count?: number
  last_user_id?: string | number | null
  has_more?: boolean
  data?: UserTypeRecord[]
}

/**
 * Fetches every page of the User Type API. Pagination is driven by the
 * `last_user_id` returned on each page and stops when the API stops
 * advancing it, returns an empty page, or reports `has_more: false`.
 * A page-count guard prevents an infinite loop.
 */
async function fetchAllUserTypes(): Promise<{
  records: UserTypeRecord[]
  pageFailures: number
}> {
  const records: UserTypeRecord[] = []
  let lastUserId: string | number = 0
  let pages = 0
  let pageFailures = 0

  while (true) {
    pages += 1
    if (pages > MAX_PAGES) {
      console.error('[users/sync] User Type API pagination exceeded the page limit')
      pageFailures += 1
      break
    }

    let res: Response
    try {
      res = await fetch(NIVESHBAY_USER_TYPE_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          api_key: NIVESHBAY_API_KEY,
          last_user_id: String(lastUserId),
        }),
        cache: 'no-store',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch {
      console.error('[users/sync] network error while contacting the User Type API')
      pageFailures += 1
      break
    }

    if (!res.ok) {
      console.error(`[users/sync] User Type API responded with HTTP ${res.status}`)
      pageFailures += 1
      break
    }

    let json: UserTypeApiPage
    try {
      json = (await res.json()) as UserTypeApiPage
    } catch {
      console.error('[users/sync] User Type API returned an invalid response')
      pageFailures += 1
      break
    }

    if (isErrorStatus(json.status)) {
      console.error(
        '[users/sync] User Type API returned an error:',
        json.message ?? json.status,
      )
      pageFailures += 1
      break
    }

    const pageRecords = Array.isArray(json.data) ? json.data : []
    records.push(...pageRecords)

    console.log(
      `[users/sync] user-type page=${pages} count=${json.count ?? pageRecords.length} ` +
        `last_user_id=${json.last_user_id ?? lastUserId} running_total=${records.length}`,
    )

    const nextLastUserId = json.last_user_id
    const advanced =
      pageRecords.length > 0 &&
      json.has_more !== false &&
      nextLastUserId != null &&
      String(nextLastUserId) !== String(lastUserId)
    if (!advanced) break
    lastUserId = nextLastUserId
  }

  return { records, pageFailures }
}

/**
 * Applies a single record: matched by `mobile`, updates ONLY `category`
 * with the exact value the API returned. Returns false (without logging)
 * when the number simply has no local match.
 */
async function applyUserType(
  admin: Pick<SupabaseClient, 'from'>,
  localMobiles: ReadonlySet<string>,
  record: UserTypeRecord,
): Promise<boolean> {
  const number = (record.number ?? '').trim()
  if (!number) {
    console.warn('[users/sync] user-type record has no number — skipped')
    return false
  }

  const userType = (record.user_type ?? '').trim()
  if (!userType) {
    console.warn(`[users/sync] user-type record for number=${number} has no user_type — skipped`)
    return false
  }

  if (!localMobiles.has(number)) {
    return false
  }

  const { error } = await admin
    .from('users')
    .update({ category: userType })
    .eq('mobile', number)
  if (error) {
    console.error(
      `[users/sync] user-type update failed for number=${number}: ${error.message}`,
    )
    return false
  }

  console.log(`[users/sync] updated category for number=${number} → ${userType}`)
  return true
}

/**
 * Loads the local mobiles, fetches every user_type.php page, and applies
 * each record in small concurrent batches. Returns the counts needed by
 * the Sync Users response.
 */
export async function syncUserTypes(
  admin: Pick<SupabaseClient, 'from'>,
): Promise<UserTypeSyncResult> {
  const { data: localRows, error: localQueryError } = await admin
    .from('users')
    .select('mobile')

  if (localQueryError) {
    console.error(
      '[users/sync] failed to load local mobiles for the user-type phase:',
      localQueryError.message,
    )
    return { typesChecked: 0, categoriesUpdated: 0, typeFetchFailed: 0 }
  }

  const localMobiles = new Set<string>()
  for (const row of (localRows ?? []) as Array<{ mobile: string | null }>) {
    const mobile = (row.mobile ?? '').trim()
    if (mobile) localMobiles.add(mobile)
  }

  const { records, pageFailures } = await fetchAllUserTypes()

  let categoriesUpdated = 0
  let typeFetchFailed = pageFailures

  for (let i = 0; i < records.length; i += CONCURRENCY) {
    const chunk = records.slice(i, i + CONCURRENCY)
    const outcomes = await Promise.allSettled(
      chunk.map((record) => applyUserType(admin, localMobiles, record)),
    )
    for (const outcome of outcomes) {
      if (outcome.status === 'fulfilled') {
        if (outcome.value) {
          categoriesUpdated += 1
        } else {
          typeFetchFailed += 1
        }
      } else {
        typeFetchFailed += 1
        console.error('[users/sync] user-type phase failed:', outcome.reason)
      }
    }
  }

  return {
    typesChecked: records.length,
    categoriesUpdated,
    typeFetchFailed,
  }
}
