/**
 * Niveshbay API configuration — single source of truth.
 *
 * The Users API (users.php, imported by the "Sync Users" flow), the User
 * API (user.php, used to backfill missing FCM tokens) and the User Type
 * API (user_type.php, used to refresh user categories) are all called from
 * the Notifications module and share the same X-API-KEY header. Defining
 * the endpoints and the key here means the header value and the URL
 * defaults live in exactly one place instead of being duplicated at each
 * call site.
 */

export const NIVESHBAY_USERS_API_URL =
  process.env.NIVESHBAY_USERS_API_URL ?? 'https://niveshbay.com/api/v1/users.php'

export const NIVESHBAY_USER_API_URL =
  process.env.NIVESHBAY_USER_API_URL ?? 'https://niveshbay.com/api/v1/user.php'

export const NIVESHBAY_USER_TYPE_API_URL =
  process.env.NIVESHBAY_USER_TYPE_API_URL ?? 'https://niveshbay.com/api/v1/user_type.php'

export const NIVESHBAY_API_KEY =
  process.env.NIVESHBAY_USERS_API_KEY ?? 'NBCOURSE_2026@Secure#API'

/**
 * True when a Niveshbay envelope reports a failing status. The APIs reply
 * with `status` in varying forms ("success", "ok", true, 1, 200, …); any
 * value that is not one of those is treated as an error. Undefined/null
 * mean "no status field" and are NOT treated as an error.
 */
export function isErrorStatus(status: unknown): boolean {
  if (status === undefined || status === null) return false
  return !(
    status === 'success' ||
    status === 'ok' ||
    status === true ||
    status === 1 ||
    status === 200
  )
}
