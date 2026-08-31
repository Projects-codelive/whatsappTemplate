import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/broadcasts/admin-client'
import { sendBroadcastBatch } from '@/lib/broadcasts/send-batch'
import { decrypt } from '@/lib/whatsapp/encryption'
import {
  resolveVariables,
  buildCustomValueIndex,
  type VariableMapping,
} from '@/lib/broadcasts/resolve-variables'
import type { Contact } from '@/types'

/**
 * Scheduled-broadcast dispatcher. Hit on a schedule (Vercel Cron /
 * external pinger) with the shared `x-cron-secret` matching
 * `AUTOMATION_CRON_SECRET`, like /api/automations/cron and
 * /api/flows/cron.
 *
 * Two jobs per invocation, both server-side:
 *
 *   ACTIVATE — claim due `scheduled` broadcasts to `sending`. The claim
 *   is atomic (`WHERE status='scheduled'`), so overlapping cron runs or
 *   a race with the user's Cancel can never double-activate.
 *
 *   SWEEP — advance cron-owned `sending` broadcasts. Recipient rows
 *   carry the progress (pending → sent/failed), so this is self-healing:
 *   a run that timed out mid-way leaves `pending` recipients behind and
 *   the next sweep continues them. `dispatch_mode='cron'` (migration
 *   017) is what keeps the sweep from touching BROWSER-driven
 *   broadcasts — a browser loop and the cron can never race the same
 *   recipients.
 *
 * Per-recipient de-duplication between overlapping sweeps: a chunk is
 * claimed with an optimistic `pending → sent` UPDATE filtered by the
 * exact ids it just selected; only the first sibling run wins each row,
 * so no phone is ever sent twice even with two concurrent sweeps.
 * Trade-off (bounded, documented): if the process is killed between a
 * claim and the Meta call, those few recipients are recorded as sent
 * but never reached the wire. Chunk size keeps the window ~10 messages.
 *
 * Each broadcast processes at most RECIPIENT_BUDGET recipients per run
 * (≈ chunk-paced wall time) before handing back; completion time for a
 * large audience = budget × pinger interval.
 */

const ACTIVATE_LIMIT = 10;
const SWEEP_LIMIT = 10;
const RECIPIENT_BUDGET = 250;
const CHUNK_SIZE = 10;
const CHUNK_DELAY_MS = 500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function authorized(request: Request): boolean {
  const expected = process.env.AUTOMATION_CRON_SECRET;
  if (!expected) return false;
  const supplied = request.headers.get('x-cron-secret') ?? '';
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function loadTemplateInfo(
  admin: ReturnType<typeof supabaseAdmin>,
  args: { user_id: string; template_name: string; template_language: string },
): Promise<{ header_type: string | null; body_text: string | null } | null> {
  const base = admin
    .from('message_templates')
    .select('header_type, body_text')
    .eq('user_id', args.user_id)
    .eq('name', args.template_name);

  const { data: langMatch } = await base
    .eq('language', args.template_language ?? 'en_US')
    .maybeSingle();
  if (langMatch) return langMatch as { header_type: string | null; body_text: string | null };

  const { data: nameMatch } = await base.maybeSingle();
  return (nameMatch as { header_type: string | null; body_text: string | null } | null) ?? null;
}

interface ProcessResult {
  sent: number;
  failed: number;
  pendingRemaining: number;
}

interface PendingChunkRow {
  id: string;
  contact_id: string | null;
  contact: Contact | null;
}

/**
 * Advance one cron-owned broadcast by up to RECIPIENT_BUDGET recipients.
 */
async function processBroadcast(broadcastId: string): Promise<ProcessResult> {
  const admin = supabaseAdmin();

  const { data: bc } = await admin
    .from('broadcasts')
    .select('*')
    .eq('id', broadcastId)
    .maybeSingle();
  if (!bc || bc.status !== 'sending') {
    // Deleted or cancelled/paused since selection — leave the row's
    // status alone (the action endpoint owns those transitions).
    return { sent: 0, failed: 0, pendingRemaining: 0 };
  }

  const { data: config } = await admin
    .from('whatsapp_config')
    .select('*')
    .eq('user_id', bc.user_id)
    .maybeSingle();
  if (!config) {
    // WhatsApp integration gone (deleted / revoked). Nothing will ever
    // deliver — fail decisively so the user sees it instead of the
    // sweep retrying forever.
    await admin
      .from('broadcasts')
      .update({ status: 'failed' })
      .eq('id', broadcastId)
      .eq('status', 'sending');
    return { sent: 0, failed: 0, pendingRemaining: 0 };
  }
  const accessToken = decrypt(config.access_token);

  const templateInfo = await loadTemplateInfo(admin, {
    user_id: bc.user_id,
    template_name: bc.template_name,
    template_language: bc.template_language,
  });
  const templateHeaderType = (templateInfo?.header_type ??
    null) as 'text' | 'image' | 'video' | 'document' | null;
  const bodyText = templateInfo?.body_text ?? undefined;

  const variables = (bc.template_variables ?? {}) as Record<string, VariableMapping>;

  let sent = 0;
  let failed = 0;

  while (sent + failed < RECIPIENT_BUDGET) {
    // A user pause/cancel landing between chunks must stop the sweep;
    // the broadcast row is the single source of truth for that.
    const { data: live } = await admin
      .from('broadcasts')
      .select('status')
      .eq('id', broadcastId)
      .maybeSingle();
    if (!live || live.status !== 'sending') break;

    const { data: chunk } = await admin
      .from('broadcast_recipients')
      .select('id, contact_id, contact:contacts(*)')
      .eq('broadcast_id', broadcastId)
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(CHUNK_SIZE);

    if (!chunk || chunk.length === 0) break; // drained

    const pendingChunk = chunk as unknown as PendingChunkRow[];

    // Atomic claim: optimistic sent. Two overlapping sweeps both select
    // the same pending ids but only one UPDATE wins each row's
    // `status='pending'` guard — the loser's RETURNING is empty.
    const { data: claimed } = await admin
      .from('broadcast_recipients')
      .update({ status: 'sent', sent_at: new Date().toISOString() })
      .in('id', pendingChunk.map((r) => r.id))
      .eq('status', 'pending')
      .select('id');

    if (!claimed || claimed.length === 0) continue; // another run took them

    const claimedIds = new Set((claimed as { id: string }[]).map((c) => c.id));
    const winners = pendingChunk.filter((r) => claimedIds.has(r.id));
    const withPhone = winners
      .filter((r) => r.contact?.phone)
      .map((r) => ({ recipientId: r.id, contact: r.contact as Contact }));

    let customIndex = buildCustomValueIndex([]);
    const contactIds = withPhone.map((r) => r.contact.id);
    if (contactIds.length > 0) {
      const { data: cvs } = await admin
        .from('contact_custom_values')
        .select('contact_id, custom_field_id, value')
        .in('contact_id', contactIds);
      customIndex = buildCustomValueIndex(cvs ?? []);
    }

    const result = await sendBroadcastBatch({
      recipients: withPhone.map((r) => ({
        phone: r.contact.phone,
        params: resolveVariables(
          variables,
          r.contact,
          customIndex.get(r.contact.id),
          bodyText,
        ),
      })),
      templateName: bc.template_name,
      templateLanguage: bc.template_language,
      templateHeaderType,
      headerImageUrl: bc.header_image_url ?? undefined,
      accessToken,
      phoneNumberId: config.phone_number_id,
    });

    const byPhone = new Map(
      result.results.map((r) => [r.phone, r] as const),
    );

    for (const winner of winners) {
      const phone = winner.contact?.phone;
      const res = phone ? byPhone.get(phone) : undefined;

      if (res?.status === 'sent') {
        await admin
          .from('broadcast_recipients')
          .update({ whatsapp_message_id: res.whatsapp_message_id ?? null })
          .eq('id', winner.id);
        sent++;
      } else {
        // Unclaim the optimistic mark so counts + error surface honestly.
        await admin
          .from('broadcast_recipients')
          .update({
            status: 'failed',
            sent_at: null,
            error_message: res?.error ?? 'No phone number on contact',
          })
          .eq('id', winner.id);
        failed++;
      }
    }

    if (sent + failed >= RECIPIENT_BUDGET) break;
    await sleep(CHUNK_DELAY_MS);
  }

  const { count } = await admin
    .from('broadcast_recipients')
    .select('*', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId)
    .eq('status', 'pending');
  const pendingRemaining = count ?? 0;

  // Drain complete (or cancelled — in which case the guarded UPDATE
  // below matches nothing and leaves the external status intact).
  if (pendingRemaining === 0) {
    const { data: finalBc } = await admin
      .from('broadcasts')
      .select('total_recipients, failed_count')
      .eq('id', broadcastId)
      .maybeSingle();
    const finalStatus =
      finalBc &&
      finalBc.total_recipients > 0 &&
      finalBc.failed_count >= finalBc.total_recipients
        ? 'failed'
        : 'sent';
    await admin
      .from('broadcasts')
      .update({ status: finalStatus })
      .eq('id', broadcastId)
      .eq('status', 'sending');
  }

  return { sent, failed, pendingRemaining };
}

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = supabaseAdmin();

  // ── Phase A: activate due scheduled broadcasts ────────────────
  let activated = 0;
  const { data: due } = await admin
    .from('broadcasts')
    .select('id')
    .eq('status', 'scheduled')
    .eq('dispatch_mode', 'cron')
    .lte('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true })
    .limit(ACTIVATE_LIMIT);

  const claimedIds = new Set<string>();
  for (const row of due ?? []) {
    const { data: claim } = await admin
      .from('broadcasts')
      .update({ status: 'sending' })
      .eq('id', row.id)
      .eq('status', 'scheduled')
      .select('id')
      .maybeSingle();
    if (claim) {
      claimedIds.add(row.id);
      activated++;
    }
  }

  // ── Phase B: sweep leftover cron-owned `sending` broadcasts ────
  let swept = 0;
  const { data: inFlight } = await admin
    .from('broadcasts')
    .select('id')
    .eq('status', 'sending')
    .eq('dispatch_mode', 'cron')
    .order('updated_at', { ascending: true })
    .limit(SWEEP_LIMIT);

  const toProcess = [...claimedIds];
  for (const row of inFlight ?? []) {
    if (claimedIds.has(row.id)) continue;
    toProcess.push(row.id);
    swept++;
  }

  let sent = 0;
  let failed = 0;
  let pendingRemaining = 0;
  for (const id of toProcess) {
    const r = await processBroadcast(id);
    sent += r.sent;
    failed += r.failed;
    pendingRemaining += r.pendingRemaining;
  }

  return NextResponse.json({
    activated,
    swept,
    sent,
    failed,
    pending_recipients: pendingRemaining,
  });
}