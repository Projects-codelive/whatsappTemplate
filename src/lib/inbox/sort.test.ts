import { describe, expect, it } from "vitest";
import { sortConversationsByActivity } from "./sort";
import { applyConversationUpdate, applyMessageInsert } from "./list";
import type { Conversation, Message } from "@/types";

function conv(partial: Partial<Conversation> & { id: string }): Conversation {
  return {
    user_id: "user-1",
    contact_id: "contact-1",
    status: "open",
    unread_count: 0,
    created_at: "2025-01-01T00:00:00.000Z",
    updated_at: "2025-01-01T00:00:00.000Z",
    ...partial,
  };
}

function msg(
  partial: Partial<Message> & { id: string; conversation_id: string },
): Message {
  return {
    sender_type: "customer",
    content_type: "text",
    content_text: "hello",
    status: "delivered",
    created_at: "2025-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("sortConversationsByActivity — conversation list ordering", () => {
  // TEST 11 — multiple conversations render in correct newest-first order.
  it("orders conversations by latest activity, newest first", () => {
    const list = [
      conv({ id: "a", last_message_at: "2025-01-01T10:00:00.000Z" }),
      conv({ id: "b", last_message_at: "2025-01-03T10:00:00.000Z" }),
      conv({ id: "c", last_message_at: "2025-01-02T10:00:00.000Z" }),
    ];
    expect(sortConversationsByActivity(list).map((c) => c.id)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  // TEST 10 — sorting never drops or duplicates rows.
  it("never duplicates or drops conversations (TEST 10)", () => {
    const list = [
      conv({ id: "a", last_message_at: "2025-01-01T10:00:00.000Z" }),
      conv({ id: "b", last_message_at: "2025-01-02T10:00:00.000Z" }),
      conv({ id: "c", last_message_at: "2025-01-03T10:00:00.000Z" }),
    ];
    const sorted = sortConversationsByActivity(list);
    expect(sorted).toHaveLength(list.length);
    expect(new Set(sorted.map((c) => c.id)).size).toBe(list.length);
  });

  // TEST 10 — repeated sorting is deterministic (no jitter on ties).
  it("is deterministic across repeated sorts", () => {
    const list = [
      conv({ id: "a", last_message_at: "2025-01-02T10:00:00.000Z" }),
      conv({ id: "b", last_message_at: "2025-01-02T10:00:00.000Z" }),
      conv({ id: "c", last_message_at: "2025-01-01T10:00:00.000Z" }),
    ];
    const once = sortConversationsByActivity(list).map((c) => c.id);
    const twice = sortConversationsByActivity(
      sortConversationsByActivity(list),
    ).map((c) => c.id);
    expect(twice).toEqual(once);
  });

  // TEST 7 — re-sorting preserves each row's unread state; a refetch
  // can't resurrect a badge that was already cleared.
  it("preserves unread state when re-sorting (TEST 7)", () => {
    const list = [
      conv({ id: "a", unread_count: 0, last_message_at: "2025-01-03T10:00:00.000Z" }),
      conv({ id: "b", unread_count: 2, last_message_at: "2025-01-02T10:00:00.000Z" }),
      conv({ id: "c", unread_count: 1, last_message_at: "2025-01-01T10:00:00.000Z" }),
    ];
    const sorted = sortConversationsByActivity(list);
    expect(sorted.map((c) => c.unread_count)).toEqual([0, 2, 1]);
  });

  // Conversations with no last_message_at sort first — matches the DB
  // fetch's Postgres NULLS-FIRST order so refetch and realtime agree.
  it("handles conversations with no activity deterministically", () => {
    const empty = conv({ id: "empty" });
    const active = conv({ id: "a", last_message_at: "2025-01-01T10:00:00.000Z" });
    expect(sortConversationsByActivity([active, empty]).map((c) => c.id)).toEqual([
      "empty",
      "a",
    ]);
  });
});

describe("applyMessageInsert — realtime message INSERT list behavior", () => {
  // TEST 1 — customer message to a closed conversation increments unread
  // AND moves the conversation to the top.
  it("marks a closed conversation unread and moves it to the top (TEST 1)", () => {
    const list = [
      conv({ id: "a", last_message_at: "2025-01-01T10:00:00.000Z" }),
      conv({ id: "b", unread_count: 0, last_message_at: "2025-01-02T10:00:00.000Z" }),
    ];
    const next = applyMessageInsert(
      list,
      msg({
        id: "m1",
        conversation_id: "b",
        created_at: "2025-01-05T10:00:00.000Z",
      }),
      false,
    );
    expect(next.map((c) => c.id)).toEqual(["b", "a"]);
    expect(next[0].unread_count).toBe(1);
    expect(next[0].last_message_text).toBe("hello");
    expect(next[0].last_message_at).toBe("2025-01-05T10:00:00.000Z");
  });

  // TEST 2 — customer message to the currently-open conversation stays
  // read (no unread) while still moving to the top.
  it("keeps the open conversation read when the customer messages it (TEST 2)", () => {
    const list = [
      conv({ id: "a", unread_count: 0, last_message_at: "2025-01-01T10:00:00.000Z" }),
      conv({ id: "b", unread_count: 0, last_message_at: "2025-01-02T10:00:00.000Z" }),
    ];
    const next = applyMessageInsert(
      list,
      msg({ id: "m1", conversation_id: "a", created_at: "2025-01-06T10:00:00.000Z" }),
      true,
    );
    expect(next.map((c) => c.id)).toEqual(["a", "b"]);
    expect(next[0].unread_count).toBe(0);
  });

  // TEST 4 — an agent's outgoing message never increments unread.
  it("does NOT increment unread on an agent outgoing message (TEST 4)", () => {
    const list = [
      conv({ id: "a", unread_count: 0, last_message_at: "2025-01-01T10:00:00.000Z" }),
      conv({ id: "b", unread_count: 5, last_message_at: "2025-01-02T10:00:00.000Z" }),
    ];
    const next = applyMessageInsert(
      list,
      msg({
        id: "m1",
        conversation_id: "b",
        sender_type: "agent",
        created_at: "2025-01-03T10:00:00.000Z",
      }),
      false,
    );
    expect(next.find((c) => c.id === "b")!.unread_count).toBe(5);
  });

  // TEST 9 — realtime message INSERT moves the latest conversation to top.
  it("moves the conversation to the top on a realtime message INSERT (TEST 9)", () => {
    const list = [
      conv({ id: "a", last_message_at: "2025-01-01T10:00:00.000Z" }),
      conv({ id: "b", last_message_at: "2025-01-02T10:00:00.000Z" }),
      conv({ id: "c", last_message_at: "2025-01-03T10:00:00.000Z" }),
    ];
    const next = applyMessageInsert(
      list,
      msg({ id: "m1", conversation_id: "a", created_at: "2025-01-04T10:00:00.000Z" }),
      false,
    );
    expect(next.map((c) => c.id)).toEqual(["a", "c", "b"]);
  });

  // TEST 6 — after the agent read/replied (unread 0), the customer's
  // next message makes it unread again and re-positions it on top.
  it("becomes unread again when the customer messages after read (TEST 6)", () => {
    const list = [
      conv({ id: "a", unread_count: 0, last_message_at: "2025-01-02T10:00:00.000Z" }),
      conv({ id: "b", unread_count: 0, last_message_at: "2025-01-01T10:00:00.000Z" }),
    ];
    const next = applyMessageInsert(
      list,
      msg({ id: "m1", conversation_id: "b", created_at: "2025-01-07T10:00:00.000Z" }),
      false,
    );
    expect(next.map((c) => c.id)).toEqual(["b", "a"]);
    expect(next[0].unread_count).toBe(1);
  });

  // TEST 12 — the open conversation stays at the top while read even
  // when other conversations have activity too.
  it("keeps the open conversation on top while it stays read (TEST 12)", () => {
    const list = [
      conv({ id: "a", unread_count: 0, last_message_at: "2025-01-03T10:00:00.000Z" }),
      conv({ id: "b", unread_count: 0, last_message_at: "2025-01-02T10:00:00.000Z" }),
      conv({ id: "c", unread_count: 0, last_message_at: "2025-01-01T10:00:00.000Z" }),
    ];
    // The agent is reading "b"; the customer replies into "b".
    const next = applyMessageInsert(
      list,
      msg({ id: "m1", conversation_id: "b", created_at: "2025-01-08T10:00:00.000Z" }),
      true,
    );
    expect(next.map((c) => c.id)).toEqual(["b", "a", "c"]);
    expect(next[0].unread_count).toBe(0);
  });
});

describe("applyConversationUpdate — realtime conversation UPDATE list behavior", () => {
  // TEST 3 — the send route's conversation UPDATE (unread_count: 0)
  // clears the badge at the list level.
  it("clears unread via the conversation UPDATE that follows an agent reply (TEST 3)", () => {
    const list = [
      conv({ id: "a", unread_count: 3, last_message_at: "2025-01-02T10:00:00.000Z" }),
    ];
    const next = applyConversationUpdate(
      list,
      conv({ id: "a", unread_count: 0, last_message_at: "2025-01-03T10:00:00.000Z" }),
      false,
    );
    expect(next[0].unread_count).toBe(0);
  });

  // TEST 5 — an agent reply updates latest activity and pushes the
  // conversation to the top.
  it("updates latest activity and order on an agent reply (TEST 5)", () => {
    const list = [
      conv({ id: "a", last_message_at: "2025-01-01T10:00:00.000Z" }),
      conv({ id: "b", last_message_at: "2025-01-02T10:00:00.000Z" }),
    ];
    const next = applyConversationUpdate(
      list,
      conv({ id: "a", unread_count: 0, last_message_at: "2025-01-05T10:00:00.000Z" }),
      false,
    );
    expect(next.map((c) => c.id)).toEqual(["a", "b"]);
  });

  // TEST 8 — a realtime conversation UPDATE moves the latest
  // conversation to the top.
  it("moves the latest conversation to the top on a realtime UPDATE (TEST 8)", () => {
    const list = [
      conv({ id: "a", last_message_at: "2025-01-02T10:00:00.000Z" }),
      conv({ id: "b", last_message_at: "2025-01-01T10:00:00.000Z" }),
      conv({ id: "c", last_message_at: "2025-01-03T10:00:00.000Z" }),
    ];
    const next = applyConversationUpdate(
      list,
      conv({ id: "b", unread_count: 0, last_message_at: "2025-01-09T10:00:00.000Z" }),
      false,
    );
    expect(next.map((c) => c.id)).toEqual(["b", "c", "a"]);
  });

  // TEST 2 (DB side) — an UPDATE arriving for the currently-open
  // conversation can't paint a badge on it.
  it("suppresses unread for the currently open conversation (TEST 2)", () => {
    const list = [
      conv({ id: "a", unread_count: 0, last_message_at: "2025-01-01T10:00:00.000Z" }),
    ];
    const next = applyConversationUpdate(
      list,
      conv({ id: "a", unread_count: 4, last_message_at: "2025-01-02T10:00:00.000Z" }),
      true,
    );
    expect(next[0].unread_count).toBe(0);
  });
});
