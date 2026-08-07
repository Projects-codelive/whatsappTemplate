import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { NOTIFICATION_CATEGORY_ALIASES } from '@/lib/notifications/categories'
import {
  isErrorStatus,
  NIVESHBAY_API_KEY,
  NIVESHBAY_USERS_API_URL,
} from '@/lib/notifications/niveshbay-api'
import {
  backfillMissingFcmTokens,
  type MissingTokenUser,
} from '@/lib/notifications/fetch-missing-tokens'
import { syncUserTypes } from '@/lib/notifications/sync-user-types'

const MAX_PAGES = 1000
const UPSERT_BATCH_SIZE = 500

// The Niveshbay Users API payload. Verified against a live response:
// each row has name, email, phone, fcm_token, user_type, user_joined_at
// and NO id field. The envelope carries status/count/last_user_id/has_more.
interface UsersApiUser {
  name?: string | null
  email?: string | null
  phone?: string | null
  fcm_token?: string | null
  user_type?: string | null
  user_joined_at?: string | null
}

interface UsersApiPage {
  status?: unknown
  message?: unknown
  count?: number
  last_user_id?: string | number | null
  has_more?: boolean
  data?: UsersApiUser[]
}

/**
 * Fetch every page of the Users API. Pagination is driven by the
 * `last_user_id` returned on each page and repeats until `has_more`
 * is false — the whole user base is always imported, never a single
 * page. A page-count guard prevents an infinite loop if the API ever
 * stops advancing `last_user_id`.
 */
async function fetchAllUsers(): Promise<UsersApiUser[]> {
  const users: UsersApiUser[] = []
  let lastUserId: string | number = 0
  let pages = 0
  let hasMore = true

  while (hasMore) {
    pages += 1
    if (pages > MAX_PAGES) {
      throw new Error('Users API pagination exceeded the page limit')
    }

    let res: Response
    try {
      res = await fetch(NIVESHBAY_USERS_API_URL, {
        method: 'POST',
        headers: {
          'X-API-KEY': NIVESHBAY_API_KEY,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ last_user_id: String(lastUserId) }),
        cache: 'no-store',
      })
    } catch {
      throw new Error('Network error while contacting the Users API')
    }

    if (!res.ok) {
      throw new Error(`Users API responded with HTTP ${res.status}`)
    }

    let json: UsersApiPage
    try {
      json = (await res.json()) as UsersApiPage
    } catch {
      throw new Error('Users API returned an invalid response')
    }

    if (isErrorStatus(json.status)) {
      throw new Error(String(json.message ?? 'Users API returned an error'))
    }

    if (Array.isArray(json.data)) {
      users.push(...json.data)
    }

    const nextLastUserId = json.last_user_id
    if (
      json.has_more === true &&
      nextLastUserId != null &&
      String(nextLastUserId) !== String(lastUserId)
    ) {
      lastUserId = nextLastUserId
    } else {
      hasMore = false
    }

    console.log(
      `[users/sync] page=${pages} count=${json.count ?? json.data?.length ?? 0} ` +
        `last_user_id=${nextLastUserId ?? lastUserId} has_more=${json.has_more} ` +
        `running_total=${users.length}`,
    )
  }

  return users
}

/**
 * The API has no per-user id, so a stable id is derived for the local
 * table. Email is the most unique field the API exposes and is present
 * on every row, so it becomes the dedup key. Fallbacks cover rows with
 * an empty email (content-hash) so a valid id always exists.
 */
function buildUserId(user: UsersApiUser): string {
  const email = (user.email ?? '').trim().toLowerCase()
  if (email) return email

  const phone = (user.phone ?? '').trim()
  if (phone) return `phone:${phone}`

  return `user:${createHash('sha1').update(JSON.stringify(user)).digest('hex')}`
}

function normalizeCategory(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return null
  // Map known user_type values to their canonical category ("free expired"
  // → "Free Expired"). Unknown values keep the legacy capitalize-first-
  // letter behaviour so no data is lost on re-sync.
  return (
    NOTIFICATION_CATEGORY_ALIASES[trimmed.toLowerCase()] ??
    (trimmed.charAt(0).toUpperCase() + trimmed.slice(1))
  )
}

function toIso(value: string | null | undefined): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

function toNotificationUser(user: UsersApiUser) {
  return {
    id: buildUserId(user),
    name: user.name ?? null,
    mobile: user.phone ?? null,
    email: user.email ?? null,
    category: normalizeCategory(user.user_type),
    fcm_token: user.fcm_token ?? null,
    joined_at: toIso(user.user_joined_at),
  }
}

export async function POST() {
  let users: UsersApiUser[]
  try {
    users = await fetchAllUsers()
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to synchronize users'
    console.error('[users/sync] failed to fetch users from the API:', message)
    return NextResponse.json({ error: message }, { status: 502 })
  }

  const rows = users.map(toNotificationUser)

  // Success is only reported when rows were actually written. If the API
  // returned no usable rows, fail loudly instead of pretending success.
  if (rows.length === 0) {
    console.error('[users/sync] the Users API returned no users')
    return NextResponse.json({ error: 'Users API returned no users' }, { status: 502 })
  }

  // The upstream API can return the same email on multiple rows, and the
  // derived id IS the email (see buildUserId). Upserting two rows with the
  // same id in one batch makes Postgres raise "ON CONFLICT DO UPDATE command
  // cannot affect row a second time". Collapse by id (last row wins) so each
  // batch contains unique conflict keys; the idempotent upsert is unchanged.
  const rowsById = new Map<string, ReturnType<typeof toNotificationUser>>()
  for (const row of rows) {
    rowsById.set(row.id, row)
  }
  const uniqueRows = Array.from(rowsById.values())

  console.log(
    `[users/sync] fetched ${users.length} users from the API, mapped ${rows.length} rows, ` +
      `unique ids=${uniqueRows.length} (collapsed ${rows.length - uniqueRows.length} duplicate conflict keys)`,
  )

  // Idempotent upsert keyed on the derived id: existing users are
  // updated, new users are inserted, and duplicates are never created.
  // Batched to keep each request well under payload limits.
  const admin = supabaseAdmin()
  for (let i = 0; i < uniqueRows.length; i += UPSERT_BATCH_SIZE) {
    const batch = uniqueRows.slice(i, i + UPSERT_BATCH_SIZE)
    const { error } = await admin.from('users').upsert(batch, { onConflict: 'id' })
    if (error) {
      console.error('[users/sync] Supabase upsert failed:', error)
      return NextResponse.json(
        { error: `Failed to save users: ${error.message}` },
        { status: 500 },
      )
    }
    console.log(`[users/sync] upserted batch ${i / UPSERT_BATCH_SIZE + 1} (${batch.length} rows)`)
  }

  console.log(`[users/sync] done — ${uniqueRows.length} users synchronized`)

  // STEP 3–6 — FCM token backfill. AFTER the upsert, find every user whose
  // fcm_token is NULL or empty and resolve the latest token from the User
  // API using the local `mobile`. Users that already have a valid token are
  // never re-fetched. Failures are logged and never fail the sync — the
  // upsert above is already committed and is not rolled back.
  const { data: missingTokenUsers, error: missingTokenQueryError } = await admin
    .from('users')
    .select('id, mobile')
    .or('fcm_token.is.null,fcm_token.eq.')

  if (missingTokenQueryError) {
    console.error(
      '[users/sync] failed to find users missing FCM tokens:',
      missingTokenQueryError.message,
    )
  }

  const backfill = await backfillMissingFcmTokens(
    admin,
    (missingTokenUsers ?? []) as MissingTokenUser[],
  )

  console.log(
    `[users/sync] fcm backfill — checked=${backfill.checkedForFcm} ` +
      `tokensUpdated=${backfill.tokensUpdated} tokenFetchFailed=${backfill.tokenFetchFailed}`,
  )

  // STEP 7 — User-type sync. AFTER the FCM backfill, refresh every user's
  // `category` from the User Type API, matched by `mobile`. Only the
  // category column is written; failures are logged and never fail the
  // sync — the upsert and token backfill above are already committed.
  const userTypes = await syncUserTypes(admin)

  console.log(
    `[users/sync] user-type sync — checked=${userTypes.typesChecked} ` +
      `categoriesUpdated=${userTypes.categoriesUpdated} typeFetchFailed=${userTypes.typeFetchFailed}`,
  )

  return NextResponse.json({
    success: true,
    synchronized: uniqueRows.length,
    ...backfill,
    ...userTypes,
  })
}
