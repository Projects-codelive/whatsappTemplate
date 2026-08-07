import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  getFcmAccessToken,
  isValidFcmToken,
  sendFcmMessage,
} from '@/lib/firebase/messaging'
import {
  expandNotificationCategory,
  isNotificationCategory,
} from '@/lib/notifications/categories'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import type { NotificationPayload } from '@/types'

/**
 * Push-notification dispatch. The browser only ever talks to this route —
 * it resolves the target (selected ids / all / category) to the `users`
 * table, collects valid `fcm_token`s, and sends each via FCM HTTP v1.
 *
 * Sending never stops on a per-user failure: every recipient is attempted
 * and the response reports sent/failed counts plus the failed user ids.
 */

const SEND_CHUNK_SIZE = 10

interface SendNotificationRequestBody {
  target?: unknown
  userIds?: unknown
  category?: unknown
  title?: unknown
  message?: unknown
}

interface UserTokenRow {
  id: string
  fcm_token: string | null
}

type ValidationResult =
  | { ok: true; payload: NotificationPayload }
  | { ok: false; error: string; status: number }

function validateSendRequest(body: SendNotificationRequestBody): ValidationResult {
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  const message = typeof body.message === 'string' ? body.message.trim() : ''

  if (!title) {
    return { ok: false, error: 'Notification title is required', status: 400 }
  }
  if (!message) {
    return { ok: false, error: 'Notification message is required', status: 400 }
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
    return { ok: true, payload: { target: 'selected', userIds, title, message } }
  }

  if (body.target === 'all') {
    return { ok: true, payload: { target: 'all', title, message } }
  }

  if (body.target === 'category') {
    const category = typeof body.category === 'string' ? body.category.trim() : ''
    if (!category) {
      return { ok: false, error: 'Select a category', status: 400 }
    }
    if (!isNotificationCategory(category)) {
      return { ok: false, error: 'Invalid notification category', status: 400 }
    }
    return { ok: true, payload: { target: 'category', category, title, message } }
  }

  return { ok: false, error: 'Invalid notification target', status: 400 }
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const limit = checkRateLimit(
      `notifications:${user.id}`,
      RATE_LIMITS.notifications,
    )
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    let body: SendNotificationRequestBody
    try {
      body = (await request.json()) as SendNotificationRequestBody
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const validation = validateSendRequest(body)
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: validation.status })
    }
    const { payload } = validation
    const { title, message } = payload

    // Resolve recipients. 'selected' scopes by id, 'category' by the
    // canonical category, 'all' takes every row. The shared expansion
    // makes "Premium" also reach legacy "Paid" rows.
    let query = supabaseAdmin().from('users').select('id, fcm_token')
    if (payload.target === 'selected') {
      query = query.in('id', payload.userIds)
    } else if (payload.target === 'category') {
      query = query.in('category', expandNotificationCategory(payload.category))
    }

    const { data, error: queryError } = await query
    if (queryError) {
      console.error('[notifications/send] failed to load users:', queryError.message)
      return NextResponse.json(
        { error: `Failed to load users: ${queryError.message}` },
        { status: 500 },
      )
    }

    const rows = (data ?? []) as UserTokenRow[]
    if (rows.length === 0) {
      const messageText =
        payload.target === 'category'
          ? `No users found in category "${payload.category}"`
          : 'No users found'
      return NextResponse.json({ error: messageText }, { status: 404 })
    }

    // Ignore null / empty / invalid FCM tokens — only real tokens go out.
    const recipients = rows.filter(
      (row): row is { id: string; fcm_token: string } =>
        isValidFcmToken(row.fcm_token),
    )
    const skipped = rows.length - recipients.length
    if (recipients.length === 0) {
      return NextResponse.json(
        { error: 'No valid FCM tokens found for the selected users' },
        { status: 400 },
      )
    }

    // Authenticate once up-front. A broken service account fails here as a
    // 502 instead of silently marking every recipient as failed.
    let accessToken: string
    try {
      accessToken = await getFcmAccessToken()
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Firebase authentication failed'
      console.error('[notifications/send] Firebase auth failed:', message)
      return NextResponse.json({ error: message }, { status: 502 })
    }

    // Send every recipient. Chunked with a small concurrency cap so large
    // audiences don't serialize into a long timeout, and a failure for one
    // token never aborts the rest.
    let sent = 0
    const failedUsers: string[] = []
    for (let i = 0; i < recipients.length; i += SEND_CHUNK_SIZE) {
      const chunk = recipients.slice(i, i + SEND_CHUNK_SIZE)
      const outcomes = await Promise.allSettled(
        chunk.map((user) =>
          sendFcmMessage({ accessToken, token: user.fcm_token, title, body: message }),
        ),
      )
      outcomes.forEach((outcome, index) => {
        const user = chunk[index]
        if (outcome.status === 'fulfilled') {
          sent += 1
        } else {
          failedUsers.push(user.id)
          const reason =
            outcome.reason instanceof Error ? outcome.reason.message : 'Unknown error'
          console.error(`[notifications/send] failed for user=${user.id}: ${reason}`)
        }
      })
    }

    console.log(
      `[notifications/send] target=${payload.target} found=${rows.length} ` +
        `skipped=${skipped} sent=${sent} failed=${failedUsers.length}`,
    )

    return NextResponse.json({
      success: true,
      sent,
      failed: failedUsers.length,
      failedUsers,
    })
  } catch (error) {
    console.error('[notifications/send] unexpected error:', error)
    return NextResponse.json(
      { error: 'Failed to send notification' },
      { status: 500 },
    )
  }
}
