import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import {
  getFcmAccessToken,
  isValidFcmToken,
  sendFcmMessage,
} from '@/lib/firebase/messaging'
import {
  validateSendRequest,
  type SendNotificationRequestBody,
} from '@/lib/notifications/validate-send-request'
import { resolveRecipientScope } from '@/lib/notifications/recipient-scope'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import {
  createNotificationCampaign,
  persistRecipientUpdate,
  finalizeCampaign,
} from '@/lib/notifications/campaign'

/**
 * Push-notification dispatch. The browser only ever talks to this route —
 * it resolves the target (selected ids / all / category) to the `users`
 * table, collects valid `fcm_token`s, and sends each via FCM HTTP v1.
 *
 * Sending never stops on a per-user failure: every recipient is attempted
 * and the response reports sent/failed counts plus the failed user ids.
 *
 * A notification_campaign + notification_recipients rows are created to
 * provide Broadcast-like reporting. The existing response shape is
 * preserved so the frontend does not break.
 *
 * Recipient DB writes use bounded retries (matching the broadcast
 * pattern) instead of fire-and-forget, so campaign counts stay
 * accurate.
 */

const SEND_CHUNK_SIZE = 10

interface UserTokenRow {
  id: string
  fcm_token: string | null
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
    const { title, message, imageUrl } = payload

    // Resolve recipients. The shared scope mirrors the recipient-count
    // endpoint, so the count the UI showed is always the set sent here —
    // 'selected' scopes by id, 'category' by the canonical category
    // (Premium also reaches legacy "Paid" rows), 'all' takes every row.
    const scope = resolveRecipientScope(payload)
    let query = supabaseAdmin().from('users').select('id, fcm_token')
    if (scope.column) {
      query = query.in(scope.column, scope.values)
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

    // Split into valid-token and no-token groups.
    const recipientsWithToken = rows.filter(
      (row): row is { id: string; fcm_token: string } =>
        isValidFcmToken(row.fcm_token),
    )
    const skippedRows = rows.filter(
      (row) => !isValidFcmToken(row.fcm_token),
    )
    if (recipientsWithToken.length === 0) {
      return NextResponse.json(
        { error: 'No valid FCM tokens found for the selected users' },
        { status: 400 },
      )
    }

    // --- Campaign creation (must succeed before any FCM sends) --------
    let campaignId: string | null = null
    let recipientRows: { id: string; recipientIndex: number }[] = []
    try {
      campaignId = await createNotificationCampaign(supabaseAdmin(), {
        userId: user.id,
        title,
        message,
        imageUrl,
        target: payload.target,
        category: payload.target === 'category' ? payload.category : undefined,
        totalTargeted: rows.length,
      })

      // Create recipient records: recipients with tokens get 'pending',
      // recipients without tokens get 'skipped'.
      const toInsert: Array<{
        campaign_id: string
        user_id: string
        fcm_token: string | null
        status: 'pending' | 'skipped'
      }> = [
        ...recipientsWithToken.map((r) => ({
          campaign_id: campaignId!,
          user_id: r.id,
          fcm_token: r.fcm_token,
          status: 'pending' as const,
        })),
        ...skippedRows.map((r) => ({
          campaign_id: campaignId!,
          user_id: r.id,
          fcm_token: null,
          status: 'skipped' as const,
        })),
      ]

      // Insert and retrieve the created recipient rows (for their ids).
      const { data: insertedRecipients, error: recInsertError } =
        await supabaseAdmin()
          .from('notification_recipients')
          .insert(toInsert)
          .select('id')

      if (recInsertError) {
        throw new Error(
          `Failed to create recipient records: ${recInsertError.message}`,
        )
      }

      // Map inserted IDs back to the send-order recipients (first N are
      // the pending ones, in the same order as recipientsWithToken).
      recipientRows = (insertedRecipients ?? []).map((r, i) => ({
        id: r.id as string,
        recipientIndex: i,
      }))
    } catch (campaignErr) {
      // Campaign/recipient creation failed — do NOT send anything.
      // This prevents untracked notifications.
      console.error('[notifications/send] campaign creation failed:', campaignErr)
      return NextResponse.json(
        {
          error:
            campaignErr instanceof Error
              ? campaignErr.message
              : 'Failed to initialize campaign tracking',
        },
        { status: 500 },
      )
    }

    // --- FCM sending (existing logic, wrapped) ------------------------
    let accessToken: string
    try {
      accessToken = await getFcmAccessToken()
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Firebase authentication failed'
      console.error('[notifications/send] Firebase auth failed:', errorMessage)
      // Mark all pending recipients as failed + finalize campaign.
      await finalizeCampaign(supabaseAdmin(), campaignId, 'failed')
      return NextResponse.json({ error: errorMessage, campaignId }, { status: 502 })
    }

    let sent = 0
    const failedUsers: string[] = []
    const failedAt = new Date().toISOString()
    for (let i = 0; i < recipientsWithToken.length; i += SEND_CHUNK_SIZE) {
      const chunk = recipientsWithToken.slice(i, i + SEND_CHUNK_SIZE)
      const outcomes = await Promise.allSettled(
        chunk.map((user) =>
          sendFcmMessage({
            accessToken,
            token: user.fcm_token,
            title,
            body: message,
            image: imageUrl,
          }),
        ),
      )

      // Await each recipient DB update with bounded retries (matching
      // the broadcast persistRecipientUpdate pattern). This keeps
      // campaign counts accurate — a failed DB write is retried
      // before moving to the next chunk.
      const chunkResults = await Promise.allSettled(
        outcomes.map(async (outcome, index) => {
          const user = chunk[index]
          const recipientIndex = i + index
          const recipientRecord = recipientRows[recipientIndex]

          if (outcome.status === 'fulfilled') {
            const result = await persistRecipientUpdate(
              supabaseAdmin(),
              recipientRecord.id,
              {
                status: 'sent',
                provider_message_id: outcome.value.messageId,
                sent_at: new Date().toISOString(),
              },
            )
            if (!result.success) {
              // DB write failed after retries — log but count as sent
              // (FCM accepted it; the DB drift is the lesser evil).
              console.error(
                `[notifications/send] DB write failed for accepted recipient ${recipientRecord.id}: ${result.errorMessage}`,
              )
            }
            return { userId: user.id, accepted: true }
          } else {
            const reason =
              outcome.reason instanceof Error ? outcome.reason.message : 'Unknown error'
            console.error(`[notifications/send] failed for user=${user.id}: ${reason}`)
            const result = await persistRecipientUpdate(
              supabaseAdmin(),
              recipientRecord.id,
              {
                status: 'failed',
                error_message: reason,
                failed_at: failedAt,
              },
            )
            if (!result.success) {
              console.error(
                `[notifications/send] DB write failed for failed recipient ${recipientRecord.id}: ${result.errorMessage}`,
              )
            }
            return { userId: user.id, accepted: false }
          }
        }),
      )

      // Collect failures after all chunk updates are persisted.
      for (const r of chunkResults) {
        if (r.status === 'fulfilled' && !r.value.accepted) {
          failedUsers.push(r.value.userId)
        }
        if (r.status === 'rejected') {
          // Should never happen — persistRecipientUpdate catches internally.
          console.error('[notifications/send] unexpected chunk result rejection:', r.reason)
        }
      }
    }

    // Count actual sent from the DB trigger (most accurate).
    sent = recipientsWithToken.length - failedUsers.length

    // --- Finalize campaign -------------------------------------------
    const campaignFinalStatus =
      failedUsers.length === 0 ? 'sent' : sent === 0 ? 'failed' : 'sent'
    await finalizeCampaign(supabaseAdmin(), campaignId, campaignFinalStatus)

    console.log(
      `[notifications/send] target=${payload.target} found=${rows.length} ` +
        `skipped=${skippedRows.length} sent=${sent} failed=${failedUsers.length}`,
    )

    return NextResponse.json({
      success: true,
      sent,
      failed: failedUsers.length,
      failedUsers,
      campaignId,
    })
  } catch (error) {
    console.error('[notifications/send] unexpected error:', error)
    return NextResponse.json(
      { error: 'Failed to send notification' },
      { status: 500 },
    )
  }
}
