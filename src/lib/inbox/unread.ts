import type { Conversation, SenderType } from "@/types";

/**
 * The `unread_count` a conversation should carry after a realtime message
 * INSERT event for it.
 *
 * This is the single decision rule for "what makes a conversation unread":
 *   - Only an inbound CUSTOMER message can create unread state.
 *   - An agent/bot's own outgoing message must NEVER create unread state.
 *   - A customer message arriving in the conversation the user is currently
 *     reading stays read — the open thread is itself the acknowledgment.
 *
 * The persisted value on `conversations.unread_count` is the source of
 * truth; this function only mirrors that same rule into the client's
 * conversation-list state so the Inbox stays consistent without waiting
 * for (or depending on) the realtime conversation UPDATE round-trip.
 */
export function unreadAfterMessageInsert({
  currentUnread,
  senderType,
  isActiveConversation,
}: {
  currentUnread: number;
  senderType: SenderType;
  isActiveConversation: boolean;
}): number {
  if (senderType !== "customer") return currentUnread;
  if (isActiveConversation) return 0;
  return currentUnread + 1;
}

/**
 * The single unread-state condition for the Inbox UI.
 *
 * A conversation is unread iff its persisted `unread_count` is greater than
 * zero. The numeric unread badge AND the blue unread dot in the conversation
 * list MUST both derive from this same predicate so they can never disagree —
 * no other field (status, last_message_at, booleans, etc.) may ever create
 * unread UI. If `unread_count` is 0 the conversation is read, period.
 */
export function isConversationUnread(
  conversation: Pick<Conversation, "unread_count">,
): boolean {
  return (conversation.unread_count ?? 0) > 0;
}
