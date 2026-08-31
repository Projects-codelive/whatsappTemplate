/**
 * Server-side broadcast batch sender.
 *
 * Extracted from /api/whatsapp/broadcast/route.ts so the scheduled-send
 * cron (which must dispatch without a browser) reuses the exact same
 * per-recipient logic: sanitize → E.164 validation → trunk-prefix
 * variant retry → Meta template send. The route keeps its auth /
 * ownership / template-header validation; this module is pure dispatch.
 *
 * Never retried here — at-most-once per call, matching the Phase 1
 * contract. Callers decide what to do with the per-recipient results.
 */
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import type { TemplateVariableValue } from '@/lib/whatsapp/template-variables'
import type { MessageTemplateHeaderType } from '@/types'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'

export interface BatchRecipient {
  phone: string
  params?: TemplateVariableValue[] | string[]
}

export interface BatchSendResult {
  phone: string
  status: 'sent' | 'failed'
  whatsapp_message_id?: string
  error?: string
}

export interface SendBroadcastBatchOptions {
  recipients: BatchRecipient[]
  templateName: string
  templateLanguage: string
  templateHeaderType?: MessageTemplateHeaderType | null
  headerImageUrl?: string
  accessToken: string
  phoneNumberId: string
}

export interface SendBroadcastBatchResult {
  results: BatchSendResult[]
  sent: number
  failed: number
  total: number
}

/**
 * Sequentially (never Promise.all — Meta rate limits and the user's
 * sender already pace with 10/batch + 1 s) send one batch of template
 * messages. Returns a result row per input recipient so callers can
 * mirror results onto broadcast_recipients.
 */
export async function sendBroadcastBatch(
  options: SendBroadcastBatchOptions,
): Promise<SendBroadcastBatchResult> {
  const {
    recipients,
    templateName,
    templateLanguage,
    templateHeaderType,
    headerImageUrl,
    accessToken,
    phoneNumberId,
  } = options

  const results: BatchSendResult[] = []
  let sent = 0
  let failed = 0

  for (const recipient of recipients) {
    const sanitized = sanitizePhoneForMeta(recipient.phone)

    if (!isValidE164(sanitized)) {
      results.push({
        phone: recipient.phone,
        status: 'failed',
        error: 'Invalid phone number format',
      })
      failed++
      continue
    }

    // Retry with phone variants on "not in allowed list" so numbers
    // that differ only in a trunk-prefix 0 still reach recipients.
    const variants = phoneVariants(sanitized)
    let sentMessageId: string | null = null
    let lastError: string | null = null

    for (const variant of variants) {
      try {
        const result = await sendTemplateMessage({
          phoneNumberId,
          accessToken,
          to: variant,
          templateName,
          language: templateLanguage || 'en_US',
          params: recipient.params ?? [],
          headerImageUrl: headerImageUrl || undefined,
          templateHeaderType,
        })
        sentMessageId = result.messageId
        lastError = null
        break
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error'
        if (!isRecipientNotAllowedError(errorMessage)) {
          lastError = errorMessage
          break
        }
        lastError = errorMessage
        // retry with next variant
      }
    }

    if (sentMessageId) {
      results.push({
        phone: recipient.phone,
        status: 'sent',
        whatsapp_message_id: sentMessageId,
      })
      sent++
    } else {
      results.push({
        phone: recipient.phone,
        status: 'failed',
        error: lastError || 'Unknown error',
      })
      failed++
    }
  }

  return { results, sent, failed, total: recipients.length }
}