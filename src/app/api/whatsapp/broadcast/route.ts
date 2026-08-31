import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { sendBroadcastBatch } from '@/lib/broadcasts/send-batch'
import type { BatchRecipient } from '@/lib/broadcasts/send-batch'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { MessageTemplateHeaderType } from '@/types'

/**
 * POST /api/whatsapp/broadcast — dispatch one batch of template
 * messages. The composer hook calls this once per 10-recipient batch;
 * the scheduled-send cron calls the shared sender directly.
 *
 * Two input shapes are accepted:
 *
 *   NEW (preferred — supports per-recipient variable substitution):
 *     {
 *       broadcast_id?: string,          // optional status guard
 *       recipients: Array<{ phone: string; params: Array<{key,value}> | string[] }>,
 *       template_name, template_language
 *     }
 *
 *   LEGACY (all phones receive the same params — kept so existing
 *   callers don't break):
 *     {
 *       phone_numbers: string[],
 *       template_params: string[],
 *       template_name, template_language
 *     }
 *
 * `recipients[].params` may be either the legacy positional `string[]`
 * (bare `{type:"text", text}` Meta parameters) or the structured
 * `Array<{key,value}>` form, where a non-numeric `key` makes
 * `sendTemplateMessage` emit `parameter_name` — the field Meta requires
 * for named-format templates.
 *
 * Rate limiting note: this endpoint is driven once per 10-recipient
 * batch by the composer, so a per-user fixed window here would throttle
 * real campaigns (old bug: campaigns > ~50 recipients hit the old
 * 5/min `broadcast:` bucket and had whole batches marked failed). The
 * launch-a-campaign budget now lives on the campaign-action endpoints
 * (/api/whatsapp/broadcast/[id]) where it matches the original intent —
 * one check per campaign start, not per batch.
 */
interface NewRecipient {
  phone: string
  params?: unknown
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

    const body = await request.json()
    const {
      broadcast_id,
      recipients: newRecipients,
      phone_numbers,
      template_name,
      template_language,
      template_params,
      header_image_url,
    } = body

    // Optional campaign-level guard: batches must not dispatch for a
    // broadcast that has been paused or cancelled since the sender's
    // last status read. The sender also re-checks between batches; this
    // closes the race at the API boundary.
    if (broadcast_id) {
      const { data: guard } = await supabase
        .from('broadcasts')
        .select('status')
        .eq('id', broadcast_id)
        .eq('user_id', user.id)
        .maybeSingle()

      if (!guard) {
        return NextResponse.json(
          { error: 'Broadcast not found' },
          { status: 404 },
        )
      }
      if (guard.status !== 'sending') {
        return NextResponse.json(
          {
            error:
              guard.status === 'paused'
                ? 'Broadcast is paused. Resume it before sending more recipients.'
                : 'Broadcast is no longer sending.',
          },
          { status: 409 },
        )
      }
    }

    // Normalize to a list of {phone, params} regardless of shape.
    let recipients: BatchRecipient[]
    if (Array.isArray(newRecipients) && newRecipients.length > 0) {
      recipients = (newRecipients as NewRecipient[]).map((r) => ({
        phone: r.phone,
        params: r.params as BatchRecipient['params'],
      }))
    } else if (Array.isArray(phone_numbers) && phone_numbers.length > 0) {
      const shared: string[] = Array.isArray(template_params)
        ? template_params
        : []
      recipients = phone_numbers.map((phone: string) => ({
        phone,
        params: shared,
      }))
    } else {
      return NextResponse.json(
        {
          error:
            'Provide either `recipients` (preferred) or `phone_numbers` — must be a non-empty array',
        },
        { status: 400 }
      )
    }

    if (!template_name) {
      return NextResponse.json(
        { error: 'template_name is required' },
        { status: 400 }
      )
    }

    // Look up the template's header_type from the local catalog so
    // sendTemplateMessage can decide whether to emit a header component —
    // and so we can reject IMAGE-header templates that arrive without a
    // header image BEFORE any recipient hits Meta. Prefer the row matching
    // the broadcast language (the sync upserts by user+name+language);
    // fall back to any row by name for legacy broadcasts that only name
    // the template.
    const headerLookup = supabase
      .from('message_templates')
      .select('header_type')
      .eq('user_id', user.id)
      .eq('name', template_name)

    let templateRecord: { header_type: string | null } | null = null

    const { data: langMatch } = await headerLookup
      .eq('language', template_language ?? 'en_US')
      .maybeSingle()

    if (langMatch) {
      templateRecord = langMatch
    } else {
      const { data: nameMatch } = await headerLookup.maybeSingle()
      templateRecord = nameMatch ?? null
    }

    const templateHeaderType =
      (templateRecord?.header_type as MessageTemplateHeaderType | null) ?? null

    if (
      templateHeaderType === 'image' &&
      !(header_image_url ?? '').trim()
    ) {
      return NextResponse.json(
        {
          error:
            'This template requires a header image. Please select an image before sending.',
        },
        { status: 400 },
      )
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('user_id', user.id)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        {
          error:
            'WhatsApp not configured. Please set up your WhatsApp integration first.',
        },
        { status: 400 }
      )
    }

    const accessToken = decrypt(config.access_token)

    const result = await sendBroadcastBatch({
      recipients,
      templateName: template_name,
      templateLanguage: template_language ?? 'en_US',
      templateHeaderType,
      headerImageUrl: header_image_url || undefined,
      accessToken,
      phoneNumberId: config.phone_number_id,
    })

    return NextResponse.json({
      success: true,
      total: result.total,
      sent: result.sent,
      failed: result.failed,
      results: result.results,
    })
  } catch (error) {
    console.error('Error in WhatsApp broadcast POST:', error)
    return NextResponse.json(
      { error: 'Failed to process broadcast' },
      { status: 500 }
    )
  }
}