import { describe, expect, it } from "vitest";
import { isConversationUnread, unreadAfterMessageInsert } from "./unread";
import type { Conversation } from "@/types";

const conversation = (unread_count: number): Conversation =>
  ({
    id: "c1",
    user_id: "u1",
    contact_id: "ct1",
    status: "open",
    unread_count,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  }) as Conversation;

const unread = (c: Conversation) => isConversationUnread(c);

describe("isConversationUnread — badge and blue dot share one unread condition", () => {
  // TEST 1 — unread_count 2 → the numeric badge AND the blue dot BOTH show.
  it("shows the badge and blue dot when unread_count is 2", () => {
    expect(unread(conversation(2))).toBe(true);
  });

  // TEST 2 — after opening the conversation unread_count is 0 → badge AND dot
  // are both hidden. There is no state where the dot shows while the badge
  // is gone, because both read the same predicate.
  it("hides the badge and blue dot once the conversation was opened (unread 0)", () => {
    expect(unread(conversation(0))).toBe(false);
  });

  // TEST 3 — a customer message in the currently-open conversation stays read.
  it("keeps the open conversation dot-less when the customer messages it", () => {
    const next = unreadAfterMessageInsert({
      currentUnread: 0,
      senderType: "customer",
      isActiveConversation: true,
    });
    expect(unread(conversation(next))).toBe(false);
  });

  // TEST 4 — a customer message to an inactive conversation → badge + dot appear.
  it("shows badge and blue dot when a customer messages an inactive conversation", () => {
    const next = unreadAfterMessageInsert({
      currentUnread: 0,
      senderType: "customer",
      isActiveConversation: false,
    });
    expect(unread(conversation(next))).toBe(true);
  });

  // TEST 5 — an agent reply in the open conversation never brings the dot back.
  it("keeps the active conversation dot-less after an agent reply", () => {
    const next = unreadAfterMessageInsert({
      currentUnread: 0,
      senderType: "agent",
      isActiveConversation: true,
    });
    expect(unread(conversation(next))).toBe(false);
  });

  // TEST 6 — an agent reply to an inactive conversation leaves unread state
  // (and therefore the dot) exactly as it was.
  it("leaves the badge/dot untouched on an agent reply to an inactive conversation", () => {
    for (const count of [0, 2]) {
      const next = unreadAfterMessageInsert({
        currentUnread: count,
        senderType: "agent",
        isActiveConversation: false,
      });
      expect(unread(conversation(next))).toBe(count > 0);
    }
  });

  // TEST 7 — opening a different conversation does not clear this one's dot;
  // each conversation's unread UI derives only from its own unread_count.
  it("keeps each conversation's dot independent of the others", () => {
    const a = conversation(2);
    const b = conversation(0);
    expect(unread(a)).toBe(true);
    expect(unread(b)).toBe(false);
    // Reading B must not touch A's count, so A's badge + dot stay.
    expect(unread(a)).toBe(true);
  });

  // TEST 8 — a realtime UPDATE that re-unreads the conversation brings the
  // badge AND the blue dot back together.
  it("shows badge and blue dot again when the server re-unreads the conversation", () => {
    expect(unread(conversation(1))).toBe(true);
    expect(unread(conversation(3))).toBe(true);
  });

  // TEST 9 — reopening an already-read conversation keeps both indicators hidden.
  it("keeps badge and blue dot hidden when reopening an already-read conversation", () => {
    expect(unread(conversation(0))).toBe(false);
  });

  // Invariant — the badge and dot can never disagree: both are driven by the
  // single predicate, so unread_count 0 can never leave a blue dot behind.
  it("never lets the blue dot show while unread_count is 0", () => {
    for (const count of [0, 1, 5, 0, 12, 0]) {
      expect(unread(conversation(count))).toBe(count > 0);
    }
  });
});
