import type { SupabaseClient } from '@supabase/supabase-js'

export type NotificationCampaignStatus = 'sending' | 'sent' | 'failed'
export type NotificationRecipientStatus = 'pending' | 'sent' | 'failed' | 'skipped'

export interface NotificationCampaign {
  id: string
  user_id: string
  title: string
  message: string
  image_url: string | null
  target: string
  category: string | null
  total_targeted: number
  sent_count: number
  failed_count: number
  skipped_count: number
  status: NotificationCampaignStatus
  created_at: string
  completed_at: string | null
}

export interface NotificationRecipient {
  id: string
  campaign_id: string
  user_id: string
  fcm_token: string | null
  status: NotificationRecipientStatus
  provider_message_id: string | null
  error_code: string | null
  error_message: string | null
  sent_at: string | null
  failed_at: string | null
  created_at: string
}

export interface CreateCampaignInput {
  userId: string
  title: string
  message: string
  imageUrl?: string
  target: string
  category?: string
  totalTargeted: number
}

export interface CreateRecipientInput {
  campaignId: string
  userId: string
  fcmToken: string | null
  status: NotificationRecipientStatus
}

/**
 * Creates a notification campaign record.
 * Returns the campaign id so the send route can attach recipients.
 */
export async function createNotificationCampaign(
  admin: SupabaseClient,
  input: CreateCampaignInput,
): Promise<string> {
  const { data, error } = await admin
    .from('notification_campaigns')
    .insert({
      user_id: input.userId,
      title: input.title,
      message: input.message,
      image_url: input.imageUrl ?? null,
      target: input.target,
      category: input.category ?? null,
      total_targeted: input.totalTargeted,
      status: 'sending',
    })
    .select('id')
    .single()

  if (error) {
    throw new Error(`Failed to create notification campaign: ${error.message}`)
  }

  return data.id as string
}

/**
 * Batch-inserts notification recipient rows.
 * Uses a single insert for the full batch (Supabase supports arrays).
 */
export async function createNotificationRecipients(
  admin: SupabaseClient,
  recipients: CreateRecipientInput[],
): Promise<void> {
  if (recipients.length === 0) return

  const { error } = await admin
    .from('notification_recipients')
    .insert(recipients)

  if (error) {
    throw new Error(`Failed to create notification recipients: ${error.message}`)
  }
}

/**
 * Bounded-retry persistence for notification_recipients rows.
 *
 * Matches the broadcast pattern (see use-broadcast-sending.ts):
 *   - At most PERSIST_RETRIES attempts.
 *   - Short linear backoff between attempts.
 *   - FCM send is never retried — this ONLY retries the DB write.
 */
const PERSIST_RETRIES = 3
const PERSIST_RETRY_BASE_DELAY_MS = 300

export interface PersistRecipientUpdateResult {
  success: boolean
  attempts: number
  errorMessage?: string
}

export async function persistRecipientUpdate(
  admin: SupabaseClient,
  recipientId: string,
  updatePayload: Record<string, unknown>,
): Promise<PersistRecipientUpdateResult> {
  let lastError: unknown = null
  for (let attempt = 1; attempt <= PERSIST_RETRIES; attempt++) {
    const { error } = await admin
      .from('notification_recipients')
      .update(updatePayload)
      .eq('id', recipientId)

    if (!error) {
      return { success: true, attempts: attempt }
    }

    lastError = error
    if (attempt < PERSIST_RETRIES) {
      await sleep(PERSIST_RETRY_BASE_DELAY_MS * attempt)
    }
  }

  const message =
    lastError instanceof Error
      ? lastError.message
      : typeof lastError === 'object' && lastError !== null && 'message' in lastError
        ? String((lastError as Record<string, unknown>).message)
        : 'Unknown persistence error'
  console.error(
    `[notifications] failed to persist recipient ${recipientId} update after ${PERSIST_RETRIES} attempts:`,
    message,
  )
  return { success: false, attempts: PERSIST_RETRIES, errorMessage: message }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Updates a single notification recipient after FCM send attempt.
 * Kept for backward compatibility — prefer persistRecipientUpdate for
 * the send loop where reliability matters.
 */
export async function updateNotificationRecipient(
  admin: SupabaseClient,
  recipientId: string,
  update: {
    status: NotificationRecipientStatus
    provider_message_id?: string
    error_code?: string
    error_message?: string
    sent_at?: string
    failed_at?: string
  },
): Promise<void> {
  const { error } = await admin
    .from('notification_recipients')
    .update(update)
    .eq('id', recipientId)

  if (error) {
    console.error(
      `[notifications/campaign] failed to update recipient ${recipientId}: ${error.message}`,
    )
  }
}

/**
 * Finalizes a campaign status.
 * Called after all recipients have been processed.
 */
export async function finalizeCampaign(
  admin: SupabaseClient,
  campaignId: string,
  status: NotificationCampaignStatus,
): Promise<void> {
  const { error } = await admin
    .from('notification_campaigns')
    .update({
      status,
      completed_at: new Date().toISOString(),
    })
    .eq('id', campaignId)

  if (error) {
    console.error(
      `[notifications/campaign] failed to finalize campaign ${campaignId}: ${error.message}`,
    )
  }
}

/**
 * Recomputes campaign aggregate counts from scratch by querying
 * notification_recipients. Safety net for when fire-and-forget
 * writes or trigger drift may have caused counts to diverge.
 */
export async function recomputeCampaignCounts(
  admin: SupabaseClient,
  campaignId: string,
): Promise<void> {
  const { error } = await admin.rpc('recompute_notification_campaign_counts', {
    camp_id: campaignId,
  })

  if (error) {
    console.error(
      `[notifications/campaign] failed to recompute counts for campaign ${campaignId}: ${error.message}`,
    )
  }
}
