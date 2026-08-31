'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Contact, MessageTemplate } from '@/types';
import {
  resolveVariables,
  type VariableMapping,
} from '@/lib/broadcasts/resolve-variables';

export { resolveVariables };
export type { VariableMapping };
export type { CustomValueIndex } from '@/lib/broadcasts/resolve-variables';

export type CustomFieldOperator = 'is' | 'is_not' | 'contains';

export interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

export interface AudienceConfig {
  type: 'all' | 'tags' | 'custom_field' | 'csv';
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: { phone: string; name?: string }[];
  /** Contacts carrying any of these tags are subtracted from the result. */
  excludeTagIds?: string[];
}

/**
 * Variable mapping — each template placeholder (by key: "1", "2", …
 * for positional, or "customer_name"/"product_name" for named) is
 * resolved at send time. `field` maps to a built-in contact field
 * (name/phone/email/company); `custom_field` maps to a
 * contact_custom_values.value row keyed by the custom_fields.id stored
 * in `value`.
 */

interface BroadcastPayload {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  headerImageUrl?: string;
  /**
   * ISO timestamp. When set the broadcast is created as `scheduled`
   * (dispatch_mode 'cron') and the composer does NOT start sending —
   * the scheduled-send cron sweeps it when due.
   */
  scheduledAt?: string;
}

interface UseBroadcastSendingReturn {
  /** Create a broadcast (from audience resolution) and immediately send
   *  it, or — when `payload.scheduledAt` is set — leave it to the cron. */
  createAndSendBroadcast: (payload: BroadcastPayload) => Promise<string>;
  /** Send an EXISTING broadcast's remaining pending recipients from the
   *  browser (resume-clicks, resend targets). Requires status 'sending'. */
  sendPreparedBroadcast: (broadcastId: string) => Promise<string>;
  isProcessing: boolean;
  progress: number;
}

/**
 * Meta rate-limit buffer. 10 per batch + 1 s pause matches the spec
 * and keeps us comfortably under Meta's per-phone-number messaging
 * rate so a large broadcast never trips the upstream limiter.
 */
const SEND_BATCH_SIZE = 10;
const SEND_BATCH_DELAY_MS = 1000;

/** `broadcast_recipients` inserts are independent of the send rate. */
const INSERT_BATCH_SIZE = 200;

const PERSIST_RETRIES = 3;
const PERSIST_RETRY_BASE_DELAY_MS = 300;

export interface PersistRecipientUpdateResult {
  success: boolean;
  attempts: number;
  errorMessage?: string;
}

/**
 * Bounded-retry persistence for broadcast_recipients rows.
 *
 * Guarantees:
 *   - At most PERSIST_RETRIES attempts.
 *   - Short linear backoff between attempts.
 *   - Meta send is never retried here — this ONLY retries the DB write.
 */
export async function persistRecipientUpdate(
  supabase: ReturnType<typeof createClient>,
  recipientId: string,
  updatePayload: Record<string, unknown>,
): Promise<PersistRecipientUpdateResult> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= PERSIST_RETRIES; attempt++) {
    const { error: retryErr } = await supabase
      .from("broadcast_recipients")
      .update(updatePayload)
      .eq("id", recipientId);

    if (!retryErr) {
      return { success: true, attempts: attempt };
    }

    lastError = retryErr;
    if (attempt < PERSIST_RETRIES) {
      await sleep(PERSIST_RETRY_BASE_DELAY_MS * attempt);
    }
  }

  const message =
    lastError instanceof Error
      ? lastError.message
      : typeof lastError === 'object' && lastError !== null && 'message' in lastError
        ? String((lastError as Record<string, unknown>).message)
        : 'Unknown persistence error';
  console.error(
    `[broadcast] failed to persist broadcast_recipients update for ${recipientId} after ${PERSIST_RETRIES} attempts:`,
    message,
  );
  return { success: false, attempts: PERSIST_RETRIES, errorMessage: message };
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface BroadcastApiResult {
  phone: string;
  status: 'sent' | 'failed';
  whatsapp_message_id?: string;
  error?: string;
}

/**
 * Bulk-fetch contact_custom_values for a set of contacts. Returns an
 * index keyed by contact_id → field_id → value.
 */
async function fetchCustomValueIndex(
  supabase: ReturnType<typeof createClient>,
  contactIds: string[],
) {
  const index = new Map<string, Map<string, string>>();
  if (contactIds.length === 0) return index;

  // Supabase PostgREST caps the .in(...) IN-clause roughly at 1000
  // values. Page through to stay safe.
  const PAGE = 500;
  for (let i = 0; i < contactIds.length; i += PAGE) {
    const slice = contactIds.slice(i, i + PAGE);
    const { data } = await supabase
      .from('contact_custom_values')
      .select('contact_id, custom_field_id, value')
      .in('contact_id', slice);

    for (const row of data ?? []) {
      const bucket = index.get(row.contact_id) ?? new Map<string, string>();
      bucket.set(row.custom_field_id, row.value ?? '');
      index.set(row.contact_id, bucket);
    }
  }
  return index;
}

export function useBroadcastSending(): UseBroadcastSendingReturn {
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);

  async function resolveAudience(audience: AudienceConfig): Promise<Contact[]> {
    const supabase = createClient();

    let contacts: Contact[] = [];

    if (audience.type === 'all') {
      const { data, error } = await supabase.from('contacts').select('*');
      if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
      contacts = data ?? [];
    } else if (
      audience.type === 'tags' &&
      audience.tagIds &&
      audience.tagIds.length > 0
    ) {
      const { data: contactTags, error: tagError } = await supabase
        .from('contact_tags')
        .select('contact_id')
        .in('tag_id', audience.tagIds);

      if (tagError)
        throw new Error(`Failed to fetch contact tags: ${tagError.message}`);

      if (contactTags && contactTags.length > 0) {
        const uniqueContactIds = [
          ...new Set(contactTags.map((ct) => ct.contact_id)),
        ];
        const { data, error } = await supabase
          .from('contacts')
          .select('*')
          .in('id', uniqueContactIds);
        if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
        contacts = data ?? [];
      }
    } else if (audience.type === 'custom_field' && audience.customField) {
      contacts = await resolveCustomFieldAudience(supabase, audience.customField);
    } else if (audience.type === 'csv' && audience.csvContacts) {
      contacts = await upsertCsvContacts(supabase, audience.csvContacts);
    }

    // Apply exclude tags (works across all contact-derived audience
    // types). CSV contacts are synthetic so exclusion doesn't apply.
    if (audience.excludeTagIds && audience.excludeTagIds.length > 0) {
      const { data: excludeRows } = await supabase
        .from('contact_tags')
        .select('contact_id')
        .in('tag_id', audience.excludeTagIds);
      const excludedIds = new Set((excludeRows ?? []).map((r) => r.contact_id));
      contacts = contacts.filter((c) => !excludedIds.has(c.id));
    }

    return contacts;
  }

  /**
   * CSV uploads arrive as raw phone/name pairs, not DB rows. Before we
   * can insert broadcast_recipients (whose contact_id FKs contacts.id),
   * we need real contacts.id UUIDs. So: look up each CSV phone in the
   * caller's contacts table; insert any that don't exist; return the
   * resolved set.
   */
  async function upsertCsvContacts(
    supabase: ReturnType<typeof createClient>,
    csvRows: { phone: string; name?: string }[],
  ): Promise<Contact[]> {
    if (csvRows.length === 0) return [];

    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      throw new Error('You are not signed in.');
    }

    // De-duplicate by phone within the CSV (users can paste duplicates).
    const uniqueByPhone = new Map<string, { phone: string; name?: string }>();
    for (const row of csvRows) {
      if (row.phone) uniqueByPhone.set(row.phone, row);
    }
    const phones = [...uniqueByPhone.keys()];

    // Single round-trip lookup of existing contacts by phone.
    const { data: existing, error: lookupErr } = await supabase
      .from('contacts')
      .select('*')
      .eq('user_id', user.id)
      .in('phone', phones);
    if (lookupErr) {
      throw new Error(`Failed to look up CSV contacts: ${lookupErr.message}`);
    }

    const byPhone = new Map<string, Contact>();
    for (const c of (existing ?? []) as Contact[]) {
      if (c.phone) byPhone.set(c.phone, c);
    }

    const missing = phones
      .filter((p) => !byPhone.has(p))
      .map((phone) => ({
        user_id: user.id,
        phone,
        name: uniqueByPhone.get(phone)?.name ?? null,
      }));

    const INSERT_CHUNK = 200;
    for (let i = 0; i < missing.length; i += INSERT_CHUNK) {
      const chunk = missing.slice(i, i + INSERT_CHUNK);
      const { data: inserted, error: insertErr } = await supabase
        .from('contacts')
        .insert(chunk)
        .select();
      if (insertErr) {
        throw new Error(`Failed to create CSV contacts: ${insertErr.message}`);
      }
      for (const c of (inserted ?? []) as Contact[]) {
        if (c.phone) byPhone.set(c.phone, c);
      }
    }

    return phones
      .map((p) => byPhone.get(p))
      .filter((c): c is Contact => Boolean(c));
  }

  async function resolveCustomFieldAudience(
    supabase: ReturnType<typeof createClient>,
    filter: CustomFieldFilter,
  ): Promise<Contact[]> {
    const { fieldId, operator, value } = filter;

    let query = supabase
      .from('contact_custom_values')
      .select('contact_id')
      .eq('custom_field_id', fieldId);

    if (operator === 'is') query = query.eq('value', value);
    else if (operator === 'is_not') query = query.neq('value', value);
    else if (operator === 'contains') query = query.ilike('value', `%${value}%`);

    const { data: matches, error: matchErr } = await query;
    if (matchErr)
      throw new Error(`Custom-field filter failed: ${matchErr.message}`);

    const contactIds = [...new Set((matches ?? []).map((m) => m.contact_id))];
    if (contactIds.length === 0) return [];

    const { data, error } = await supabase
      .from('contacts')
      .select('*')
      .in('id', contactIds);
    if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);
    return data ?? [];
  }

  /**
   * Reconstruct the MessageTemplate for a broadcast from the local
   * catalog (name + language), falling back to any row by name. Needed
   * for `body_text` placeholder ordering when sending a prepared
   * broadcast (resume / resend) that wasn't created by this session.
   */
  async function fetchTemplateForBroadcast(
    supabase: ReturnType<typeof createClient>,
    broadcast: { user_id: string; template_name: string; template_language: string },
  ): Promise<MessageTemplate> {
    const base = supabase
      .from('message_templates')
      .select('*')
      .eq('user_id', broadcast.user_id)
      .eq('name', broadcast.template_name);

    const { data: langMatch, error } = await base
      .eq('language', broadcast.template_language ?? 'en_US')
      .maybeSingle();

    if (error) throw new Error(`Failed to load template: ${error.message}`);
    if (langMatch) return langMatch as MessageTemplate;

    const { data: nameMatch } = await base.maybeSingle();
    if (!nameMatch) {
      throw new Error(
        `Template "${broadcast.template_name}" is no longer available`,
      );
    }
    return nameMatch as MessageTemplate;
  }

  interface SendLoopContext {
    broadcastId: string;
    template: MessageTemplate;
    variables: Record<string, VariableMapping>;
    headerImageUrl?: string;
  }

  /**
   * Shared send loop for a broadcast whose recipient rows already
   * exist. Phase 3 behaviors:
   *   - Only `pending` recipients are sent, so a resumed broadcast
   *     never re-sends already-delivered contacts.
   *   - Before every batch the broadcast's status is re-read; any value
   *     other than `sending` (pause/cancel raced from another tab, or a
   *     409/404 from the dispatch API) stops the loop mid-flight
   *     WITHOUT marking the un-sent recipients failed — they stay
   *     `pending` so a resume can continue them.
   *   - Finalize claims `sending → sent|failed` only when the loop
   *     actually finished; a stopped loop leaves the broadcast exactly
   *     as the action endpoint set it.
   */
  async function runSendLoop(
    context: SendLoopContext,
    supabase: ReturnType<typeof createClient>,
    setProgressFn: (value: number) => void,
  ): Promise<void> {
    const { broadcastId, template, variables, headerImageUrl } = context;

    const { data: recipients, error: recipientsFetchError } = await supabase
      .from('broadcast_recipients')
      .select('*, contact:contacts(*)')
      .eq('broadcast_id', broadcastId)
      .eq('status', 'pending');

    if (recipientsFetchError || !recipients) {
      throw new Error('Failed to fetch broadcast recipients');
    }

    const contactIds = recipients
      .map((r) => r.contact?.id)
      .filter((id): id is string => Boolean(id));
    const customValueIndex = await fetchCustomValueIndex(supabase, contactIds);

    let failedCount = 0;
    let stoppedEarly = false;
    const totalRecipients = recipients.length;

    for (let i = 0; i < recipients.length; i += SEND_BATCH_SIZE) {
      // ── Pre-batch status guard ────────────────────────────────
      const { data: statusRow } = await supabase
        .from('broadcasts')
        .select('status')
        .eq('id', broadcastId)
        .single();
      if (!statusRow || statusRow.status !== 'sending') {
        stoppedEarly = true;
        break;
      }

      const batch = recipients.slice(i, i + SEND_BATCH_SIZE);

      const apiRecipients = batch
        .filter((r) => r.contact?.phone)
        .map((r) => ({
          phone: r.contact!.phone as string,
          params: r.contact
            ? resolveVariables(
                variables,
                r.contact,
                customValueIndex.get(r.contact.id),
                template.body_text,
              )
            : [],
        }));

      if (apiRecipients.length === 0) continue;

      try {
        const res = await fetch('/api/whatsapp/broadcast', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            broadcast_id: broadcastId,
            recipients: apiRecipients,
            template_name: template.name,
            template_language: template.language ?? 'en_US',
            header_image_url: headerImageUrl || undefined,
          }),
        });

        // Paused/cancelled/deleted between our status read and the API —
        // stop cleanly, leave the batch pending.
        if (res.status === 409 || res.status === 404) {
          stoppedEarly = true;
          break;
        }

        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.error || 'Broadcast API request failed');
        }

        const resultsByPhone = new Map<string, BroadcastApiResult>();
        for (const r of (data.results ?? []) as BroadcastApiResult[]) {
          resultsByPhone.set(r.phone, r);
        }

        for (const recipient of batch) {
          const phone = recipient.contact?.phone;
          const result = phone ? resultsByPhone.get(phone) : undefined;

          if (!result) {
            failedCount++;
            await supabase
              .from('broadcast_recipients')
              .update({
                status: 'failed',
                error_message: 'No phone number on contact',
              })
              .eq('id', recipient.id);
            continue;
          }

          if (result.status === 'sent') {
            const persistResult = await persistRecipientUpdate(
              supabase,
              recipient.id,
              {
                status: 'sent',
                sent_at: new Date().toISOString(),
                whatsapp_message_id: result.whatsapp_message_id ?? null,
                error_message: null,
              },
            );

            if (!persistResult.success) {
              failedCount++;
              await supabase
                .from('broadcast_recipients')
                .update({
                  status: 'failed',
                  error_message: `Failed to record send: ${persistResult.errorMessage}`,
                })
                .eq('id', recipient.id);
            }
          } else {
            failedCount++;
            await supabase
              .from('broadcast_recipients')
              .update({
                status: 'failed',
                error_message: result.error ?? 'Unknown error',
              })
              .eq('id', recipient.id);
          }
        }
      } catch (err) {
        for (const recipient of batch) {
          failedCount++;
          await supabase
            .from('broadcast_recipients')
            .update({
              status: 'failed',
              error_message: err instanceof Error ? err.message : 'Unknown error',
            })
            .eq('id', recipient.id);
        }
      }

      const progressPct =
        30 + Math.round(((i + batch.length) / totalRecipients) * 60);
      setProgressFn(Math.min(99, progressPct));

      if (i + SEND_BATCH_SIZE < recipients.length) {
        await sleep(SEND_BATCH_DELAY_MS);
      }
    }

    // Only finalize when the loop actually drained every pending
    // recipient. The `WHERE status = 'sending'` claim keeps a pause /
    // cancel that landed after the last batch from being overwritten.
    if (!stoppedEarly) {
      const finalStatus =
        totalRecipients > 0 && failedCount === totalRecipients
          ? 'failed'
          : 'sent';
      await supabase
        .from('broadcasts')
        .update({ status: finalStatus })
        .eq('id', broadcastId)
        .eq('status', 'sending');
    }
  }

  async function createAndSendBroadcast(payload: BroadcastPayload): Promise<string> {
    setIsProcessing(true);
    setProgress(0);

    const supabase = createClient();

    try {
      // ── Step 0: Resolve current user ──────────────────────────────
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) {
        throw new Error('You are not signed in.');
      }

      const isScheduled = Boolean(payload.scheduledAt);
      if (isScheduled) {
        const scheduledMs = new Date(payload.scheduledAt as string).getTime();
        if (Number.isNaN(scheduledMs)) {
          throw new Error('Please pick a valid send time.');
        }
        if (scheduledMs <= Date.now()) {
          throw new Error('Scheduled time must be in the future.');
        }
      }

      // ── Step 1: Resolve audience contacts ─────────────────────────
      setProgress(5);
      const contacts = await resolveAudience(payload.audience);

      if (contacts.length === 0) {
        throw new Error('No contacts found for this audience.');
      }

      // ── Step 2: Create broadcast row ──────────────────────────────
      // Scheduled builds get status 'scheduled' + dispatch_mode 'cron'
      // (the cron sweeps them). Everything else is 'sending'/'browser'
      // and gets pushed here. The recipients are inserted now so the
      // audience snapshot is fixed and the cron never re-resolves it.
      setProgress(10);
      const { data: broadcast, error: broadcastError } = await supabase
        .from('broadcasts')
        .insert({
          user_id: user.id,
          name: payload.name,
          template_name: payload.template.name,
          template_language: payload.template.language ?? 'en_US',
          template_variables: payload.variables,
          audience_filter: {
            type: payload.audience.type,
            tagIds: payload.audience.tagIds,
            customField: payload.audience.customField,
            excludeTagIds: payload.audience.excludeTagIds,
          },
          header_image_url: payload.headerImageUrl ?? null,
          dispatch_mode: isScheduled ? 'cron' : 'browser',
          status: isScheduled ? 'scheduled' : 'sending',
          scheduled_at: isScheduled
            ? new Date(payload.scheduledAt as string).toISOString()
            : null,
          total_recipients: contacts.length,
          sent_count: 0,
          delivered_count: 0,
          read_count: 0,
          replied_count: 0,
          failed_count: 0,
        })
        .select()
        .single();

      if (broadcastError || !broadcast) {
        throw new Error(
          `Failed to create broadcast: ${broadcastError?.message ?? 'unknown error'}`,
        );
      }

      // ── Step 3: Insert recipient rows ─────────────────────────────
      setProgress(20);
      const recipientRows = contacts.map((contact) => ({
        broadcast_id: broadcast.id,
        contact_id: contact.id,
        status: 'pending' as const,
      }));

      for (let i = 0; i < recipientRows.length; i += INSERT_BATCH_SIZE) {
        const batch = recipientRows.slice(i, i + INSERT_BATCH_SIZE);
        const { error: recipientError } = await supabase
          .from('broadcast_recipients')
          .insert(batch);
        if (recipientError) {
          await supabase
            .from('broadcasts')
            .update({
              status: 'failed',
              failed_count: contacts.length,
            })
            .eq('id', broadcast.id);
          throw new Error(
            `Failed to insert recipient batch ${i / INSERT_BATCH_SIZE + 1}: ${recipientError.message}`,
          );
        }
      }

      // Scheduled broadcasts hand off to the cron — the composer stops here.
      if (isScheduled) {
        setProgress(100);
        return broadcast.id;
      }

      // ── Step 4+: run the shared send loop ─────────────────────────
      await runSendLoop(
        {
          broadcastId: broadcast.id,
          template: payload.template,
          variables: payload.variables,
          headerImageUrl: payload.headerImageUrl,
        },
        supabase,
        setProgress,
      );

      setProgress(100);
      return broadcast.id;
    } finally {
      setIsProcessing(false);
    }
  }

  async function sendPreparedBroadcast(broadcastId: string): Promise<string> {
    setIsProcessing(true);
    setProgress(0);

    const supabase = createClient();

    try {
      const { data: broadcast, error: bcErr } = await supabase
        .from('broadcasts')
        .select('*')
        .eq('id', broadcastId)
        .single();

      if (bcErr || !broadcast) {
        throw new Error(
          bcErr?.message ?? 'Broadcast not found — it may have been deleted.',
        );
      }

      // Scheduled/cron broadcasts are exclusively server-dispatched; the
      // browser must not double-send against the sweep.
      if (broadcast.dispatch_mode === 'cron') {
        throw new Error(
          'This broadcast is dispatched by the scheduled sender on the server.',
        );
      }

      if (broadcast.status !== 'sending') {
        throw new Error(
          `Broadcast is ${broadcast.status} — resume it before sending.`,
        );
      }

      const template = await fetchTemplateForBroadcast(supabase, broadcast);
      const variables = (broadcast.template_variables ??
        {}) as Record<string, VariableMapping>;

      setProgress(5);
      await runSendLoop(
        {
          broadcastId,
          template,
          variables,
          headerImageUrl: broadcast.header_image_url,
        },
        supabase,
        setProgress,
      );

      setProgress(100);
      return broadcastId;
    } finally {
      setIsProcessing(false);
    }
  }

  return { createAndSendBroadcast, sendPreparedBroadcast, isProcessing, progress };
}