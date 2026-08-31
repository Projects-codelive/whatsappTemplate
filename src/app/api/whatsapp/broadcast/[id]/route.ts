import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/broadcasts/admin-client'
import {
  CANCELLABLE_STATUSES,
  assertTransition,
} from '@/lib/broadcasts/status-machine'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'

/**
 * POST /api/whatsapp/broadcast/[id]
 *
 * Campaign-level actions for one broadcast:
 *
 *   pause   sending → paused      — stop the browser/composer loop at the
 *                                   next batch boundary. Already-sent
 *                                   recipients stay sent.
 *   resume  paused  → sending     — pick pending recipients back up.
 *   cancel  scheduled|sending|paused → cancelled
 *   resend  sent|failed|cancelled → builds ONE new broadcast targeting
 *                                   only recipients who were actually
 *                                   delivered but never replied.
 *
 * Every status mutation is an atomic claim (`UPDATE ... WHERE status =
 * <expected-from>`) so overlapping clicks/crons can never double-advance:
 * the loser matches zero rows and gets a 409.
 *
 * Rate limit: `resend` creates a whole new campaign, so it consumes the
 * per-user broadcast launch budget (RATE_LIMITS.broadcast). The old
 * per-batch limiter that incorrectly shared this key was removed from
 * /api/whatsapp/broadcast — this endpoint is where the original
 * "cap how often a user launches campaigns" intent belongs.
 */

const RESEND_FROM: readonly string[] = ['sent', 'failed', 'cancelled'];

async function requireOwnership(
  broadcastId: string,
): Promise<
  | { ok: true; userId: string }
  | { ok: false; status: number; body: { error: string } }
> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return { ok: false, status: 401, body: { error: 'Unauthorized' } }
  }
  // RLS scopes this to the caller — a broadcast owned by another user
  // returns null (404 below).
  const { data: row } = await supabase
    .from('broadcasts')
    .select('id')
    .eq('id', broadcastId)
    .maybeSingle()
  if (!row) {
    return { ok: false, status: 404, body: { error: 'Not found' } }
  }
  return { ok: true, userId: user.id }
}

async function atomicallyTransition(
  id: string,
  userId: string,
  from: string | string[],
  to: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  let claim = supabaseAdmin().from('broadcasts').update({ status: to })
  if (Array.isArray(from)) {
    claim = claim.in('status', from)
  } else {
    claim = claim.eq('status', from)
  }
  const { data, error } = await claim
    .eq('id', id)
    .eq('user_id', userId)
    .select('id')
    .maybeSingle()

  if (error) {
    return { ok: false, status: 500, error: error.message }
  }
  if (!data) {
    return {
      ok: false,
      status: 409,
      error: `Broadcast is not in a valid state for that action. Refresh and try again.`,
    }
  }
  return { ok: true }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params
  const guard = await requireOwnership(id)
  if (!guard.ok) return NextResponse.json(guard.body, { status: guard.status })

  const body = (await request.json().catch(() => null)) as {
    action?: string
  } | null
  const action = body?.action
  if (!action || !['pause', 'resume', 'cancel', 'resend'].includes(action)) {
    return NextResponse.json(
      { error: 'Provide a valid `action`: pause, resume, cancel, or resend' },
      { status: 400 },
    )
  }

  // ── Resume ───────────────────────────────────────────────────
  if (action === 'resume') {
    assertTransition('paused', 'sending')
    const claim = await atomicallyTransition(id, guard.userId, 'paused', 'sending')
    if (!claim.ok) return NextResponse.json({ error: claim.error }, { status: claim.status })
    return NextResponse.json({ ok: true, status: 'sending' })
  }

  // ── Pause ────────────────────────────────────────────────────
  if (action === 'pause') {
    assertTransition('sending', 'paused')
    const claim = await atomicallyTransition(id, guard.userId, 'sending', 'paused')
    if (!claim.ok) return NextResponse.json({ error: claim.error }, { status: claim.status })
    return NextResponse.json({ ok: true, status: 'paused' })
  }

  // ── Cancel ───────────────────────────────────────────────────
  if (action === 'cancel') {
    for (const from of CANCELLABLE_STATUSES) assertTransition(from, 'cancelled')
    const claim = await atomicallyTransition(
      id,
      guard.userId,
      CANCELLABLE_STATUSES as unknown as string[],
      'cancelled',
    )
    if (!claim.ok) return NextResponse.json({ error: claim.error }, { status: claim.status })
    return NextResponse.json({ ok: true, status: 'cancelled' })
  }

  // ── Resend to Non-Responders ─────────────────────────────────
  const limit = checkRateLimit(`broadcast:${guard.userId}`, RATE_LIMITS.broadcast)
  if (!limit.success) return rateLimitResponse(limit)

  const admin = supabaseAdmin()

  const { data: source, error: sourceErr } = await admin
    .from('broadcasts')
    .select('*')
    .eq('id', id)
    .eq('user_id', guard.userId)
    .maybeSingle()

  if (sourceErr || !source) {
    return NextResponse.json(
      { error: sourceErr?.message ?? 'Broadcast not found' },
      { status: sourceErr ? 500 : 404 },
    )
  }
  if (!RESEND_FROM.includes(source.status)) {
    return NextResponse.json(
      {
        error:
          source.status === 'sending' || source.status === 'scheduled'
            ? 'Wait for the broadcast to finish before resending.'
            : 'This broadcast is not resendable in its current state.',
      },
      { status: 409 },
    )
  }

  // Idempotency: at most one resend per source broadcast (also enforced
  // at the DB by idx_broadcasts_resend_once). A repeat click returns the
  // existing resend instead of duplicating it.
  const { data: existing } = await admin
    .from('broadcasts')
    .select('id')
    .eq('user_id', guard.userId)
    .eq('parent_broadcast_id', id)
    .maybeSingle()

  if (existing) {
    const { count } = await admin
      .from('broadcast_recipients')
      .select('*', { count: 'exact', head: true })
      .eq('broadcast_id', existing.id)
    return NextResponse.json({
      ok: true,
      already: true,
      broadcast_id: existing.id,
      recipient_count: count ?? 0,
    })
  }

  // Who actually received (and never replied)? 'replied' has its own
  // status and is excluded by membership; 'pending'/'failed' never
  // reached the user. Orphaned rows (contact deleted) can't be targeted.
  const { data: delivered, error: recErr } = await admin
    .from('broadcast_recipients')
    .select('contact_id')
    .eq('broadcast_id', id)
    .in('status', ['sent', 'delivered', 'read'])
    .not('contact_id', 'is', null)

  if (recErr) {
    return NextResponse.json({ error: recErr.message }, { status: 500 })
  }

  const contactIds = [
    ...new Set((delivered ?? []).map((r) => r.contact_id as string)),
  ]
  if (contactIds.length === 0) {
    return NextResponse.json(
      {
        error:
          'No recipients to resend — everyone who received this broadcast has already replied, or nothing was delivered.',
      },
      { status: 409 },
    )
  }

  const { data: created, error: insErr } = await admin
    .from('broadcasts')
    .insert({
      user_id: guard.userId,
      name: `${source.name} (Resend)`,
      template_name: source.template_name,
      template_language: source.template_language,
      template_variables: source.template_variables,
      audience_filter: null,
      header_image_url: source.header_image_url ?? null,
      dispatch_mode: 'browser',
      status: 'sending',
      parent_broadcast_id: source.id,
      total_recipients: contactIds.length,
      sent_count: 0,
      delivered_count: 0,
      read_count: 0,
      replied_count: 0,
      failed_count: 0,
    })
    .select('id')
    .single()

  if (insErr) {
    // Duplicate click raced between the pre-check and this insert — the
    // unique partial index (user_id, parent_broadcast_id) is the
    // authoritative backstop. Resolve to the winning row.
    if (insErr.code === '23505') {
      const { data: winner } = await admin
        .from('broadcasts')
        .select('id')
        .eq('user_id', guard.userId)
        .eq('parent_broadcast_id', id)
        .maybeSingle()
      if (winner) {
        const { count } = await admin
          .from('broadcast_recipients')
          .select('*', { count: 'exact', head: true })
          .eq('broadcast_id', winner.id)
        return NextResponse.json({
          ok: true,
          already: true,
          broadcast_id: winner.id,
          recipient_count: count ?? 0,
        })
      }
    }
    return NextResponse.json(
      { error: `Failed to create resend: ${insErr.message}` },
      { status: 500 },
    )
  }

  // Recipient snapshot for the new broadcast — all pending; the user's
  // browser then pushes them via the shared composer send loop.
  const { error: recepErr } = await admin.from('broadcast_recipients').insert(
    contactIds.map((contact_id) => ({
      broadcast_id: created.id,
      contact_id,
      status: 'pending',
    })),
  )
  if (recepErr) {
    // Clean up the half-created broadcast so the idempotency backstop
    // stays clean — a partial resend row with zero/pending recipients
    // is worse than none.
    await admin.from('broadcasts').delete().eq('id', created.id)
    return NextResponse.json(
      { error: `Failed to create recipients: ${recepErr.message}` },
      { status: 500 },
    )
  }

  return NextResponse.json({
    ok: true,
    already: false,
    broadcast_id: created.id,
    recipient_count: contactIds.length,
  })
}