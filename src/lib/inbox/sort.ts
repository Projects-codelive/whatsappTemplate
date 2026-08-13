import type { Conversation } from "@/types";

function parseTs(value: string | undefined): number {
  if (!value) return Number.NaN;
  const t = Date.parse(value);
  return Number.isNaN(t) ? Number.NaN : t;
}

/**
 * Order the Inbox conversation list by latest activity, newest first.
 *
 * `conversations.last_message_at` is the authoritative activity
 * timestamp — every message event writes it on both the inbound side
 * (the WhatsApp webhook) and the outbound side (the send route, the
 * automations engine, and the flows engine). Conversations that have
 * never had a message (last_message_at NULL) sort first, matching the
 * existing `order by last_message_at desc` fetch's Postgres NULLS-FIRST
 * behaviour, so refetches and live realtime updates agree. Ties break
 * on `created_at`, then `id`, so repeated re-sorts are deterministic
 * and can never jitter the list.
 */
export function sortConversationsByActivity(
  list: Conversation[],
): Conversation[] {
  return [...list].sort((a, b) => {
    const aTs = parseTs(a.last_message_at);
    const bTs = parseTs(b.last_message_at);
    const aNull = Number.isNaN(aTs);
    const bNull = Number.isNaN(bTs);
    if (aNull !== bNull) return aNull ? -1 : 1;
    if (!aNull && aTs !== bTs) return bTs - aTs;

    const aCreated = parseTs(a.created_at);
    const bCreated = parseTs(b.created_at);
    if (aCreated !== bCreated) {
      const aHas = !Number.isNaN(aCreated);
      const bHas = !Number.isNaN(bCreated);
      if (aHas && bHas) return bCreated - aCreated;
      if (aHas) return -1;
      if (bHas) return 1;
    }

    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
}
