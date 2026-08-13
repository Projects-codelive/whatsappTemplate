import type { Conversation, Message } from "@/types";
import { unreadAfterMessageInsert } from "./unread";
import { sortConversationsByActivity } from "./sort";

/**
 * The conversation-list transformation applied when a realtime message
 * INSERT event arrives for a conversation the client already knows.
 *
 * This is the single rule for how a message moves the list:
 *   - The preview (last_message_text) and the activity timestamp
 *     (last_message_at) follow the message.
 *   - unread_count follows unreadAfterMessageInsert — only an inbound
 *     CUSTOMER message to a conversation the agent is NOT currently
 *     viewing can make it unread; the agent/bot's own outgoing message
 *     INSERT must never make a conversation look unread.
 *   - The list is re-sorted by last_message_at so the conversation with
 *     the latest activity moves to the top (WhatsApp-style ordering).
 */
export function applyMessageInsert(
  list: Conversation[],
  message: Message,
  isActiveConversation: boolean,
): Conversation[] {
  return sortConversationsByActivity(
    list.map((c) =>
      c.id === message.conversation_id
        ? {
            ...c,
            last_message_text: message.content_text ?? "",
            last_message_at: message.created_at,
            unread_count: unreadAfterMessageInsert({
              currentUnread: c.unread_count,
              senderType: message.sender_type,
              isActiveConversation,
            }),
          }
        : c,
    ),
  );
}

/**
 * The conversation-list transformation applied when a realtime
 * conversation UPDATE event arrives for a conversation already in the
 * list. The webhook (inbound) and every outbound send path bump
 * `last_message_at` on each message, so the list is re-sorted to keep
 * latest-activity first. The conversation the agent is currently
 * viewing never shows a badge — the open thread is itself the read
 * acknowledgment — so its incoming unread_count is suppressed here and
 * reconciled on activeConversation (where MessageThread's reset effect
 * persists the read state to the DB).
 */
export function applyConversationUpdate(
  list: Conversation[],
  update: Conversation,
  isActiveConversation: boolean,
): Conversation[] {
  return sortConversationsByActivity(
    list.map((c) =>
      c.id === update.id
        ? {
            ...c,
            ...update,
            unread_count: isActiveConversation ? 0 : update.unread_count,
          }
        : c,
    ),
  );
}
