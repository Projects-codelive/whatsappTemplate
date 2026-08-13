import { describe, expect, it } from "vitest";
import { unreadAfterMessageInsert } from "./unread";

describe("unreadAfterMessageInsert — what makes a conversation unread", () => {
  // TEST 1 — an inbound customer message marks the conversation unread.
  it("marks a conversation unread when the customer sends a message", () => {
    expect(
      unreadAfterMessageInsert({
        currentUnread: 0,
        senderType: "customer",
        isActiveConversation: false,
      }),
    ).toBe(1);
  });

  // TEST 3 — a customer message in the currently-open conversation stays read.
  it("keeps the open conversation read when the customer messages it", () => {
    expect(
      unreadAfterMessageInsert({
        currentUnread: 0,
        senderType: "customer",
        isActiveConversation: true,
      }),
    ).toBe(0);
  });

  // TEST 4 — an agent's own outgoing message never creates unread state.
  it("does NOT mark a conversation unread on an agent outgoing message", () => {
    for (const currentUnread of [0, 1, 5]) {
      expect(
        unreadAfterMessageInsert({
          currentUnread,
          senderType: "agent",
          isActiveConversation: false,
        }),
      ).toBe(currentUnread);
    }
  });

  // TEST 8 — a bot (automation/flow) outgoing message never creates unread
  // state, and never re-creates it after the conversation was read.
  it("does NOT mark a conversation unread on a bot outgoing message", () => {
    for (const currentUnread of [0, 3]) {
      expect(
        unreadAfterMessageInsert({
          currentUnread,
          senderType: "bot",
          isActiveConversation: false,
        }),
      ).toBe(currentUnread);
    }
  });

  // TEST 5 — after the conversation was read (unread 0), the customer's next
  // message makes it unread again.
  it("becomes unread again when the customer sends another message after read", () => {
    expect(
      unreadAfterMessageInsert({
        currentUnread: 0,
        senderType: "customer",
        isActiveConversation: false,
      }),
    ).toBe(1);
  });

  // TEST 7 — the client-side mirror follows the same rule for a realtime
  // inbound message regardless of the current count.
  it("increments from any current unread level for an inbound customer message", () => {
    expect(
      unreadAfterMessageInsert({
        currentUnread: 2,
        senderType: "customer",
        isActiveConversation: false,
      }),
    ).toBe(3);
  });

  // TEST 9 — multiple agent replies keep the conversation read.
  it("keeps a conversation read across any number of agent replies", () => {
    let unread = 0;
    for (let i = 0; i < 10; i++) {
      unread = unreadAfterMessageInsert({
        currentUnread: unread,
        senderType: "agent",
        isActiveConversation: false,
      });
    }
    expect(unread).toBe(0);
  });

  // TEST 10 — multiple conversations maintain independent unread states.
  it("computes each conversation's unread state independently", () => {
    const state = { a: 0, b: 0 };
    // Customer messages both conversations, A then B.
    state.a = unreadAfterMessageInsert({
      currentUnread: state.a,
      senderType: "customer",
      isActiveConversation: false,
    }); // A = 1
    state.b = unreadAfterMessageInsert({
      currentUnread: state.b,
      senderType: "customer",
      isActiveConversation: false,
    }); // B = 1
    // Agent replies in A only.
    state.a = unreadAfterMessageInsert({
      currentUnread: state.a,
      senderType: "agent",
      isActiveConversation: false,
    });
    // A must stay 1 (agent replies never change it); B stays 1.
    expect(state).toEqual({ a: 1, b: 1 });

    // The agent opens A — the open thread is the read acknowledgment.
    state.a = unreadAfterMessageInsert({
      currentUnread: state.a,
      senderType: "customer",
      isActiveConversation: true,
    }); // A = 0
    expect(state).toEqual({ a: 0, b: 1 });
  });
});
