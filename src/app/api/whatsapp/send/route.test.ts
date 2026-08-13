import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetRateLimitForTests } from "@/lib/rate-limit";

// Shared, resettable mock state — `vi.mock` factories are hoisted above
// imports, so anything they touch must live in `vi.hoisted()`.
const mockState = vi.hoisted(() => {
  const state = {
    conversationUpdates: [] as Array<Record<string, unknown>>,
    messageInserts: [] as Array<Record<string, unknown>>,
  };

  function makeChain(table: string) {
    const b = {
      inserted: false,
      updated: false,
      last: "select",
      filters: {} as Record<string, unknown>,
    };

    const chain = {
      _table: table,
      // Make the chain awaitable, mirroring Supabase's thenable builders.
      then(onFulfilled: (v: unknown) => void) {
        return Promise.resolve(onFulfilled(computeResult()));
      },
      select: () => {
        b.last = "select";
        return chain;
      },
      eq: (col: string, val: unknown) => {
        b.last = "eq";
        b.filters = { ...b.filters, [col]: val };
        return chain;
      },
      in: () => {
        b.last = "in";
        return chain;
      },
      order: () => {
        b.last = "order";
        return chain;
      },
      limit: () => {
        b.last = "limit";
        return chain;
      },
      maybeSingle: () => {
        b.last = "maybeSingle";
        return chain;
      },
      single: () => {
        b.last = "single";
        return chain;
      },
      update: (payload: Record<string, unknown>) => {
        b.updated = true;
        b.last = "update";
        if (table === "conversations") {
          state.conversationUpdates.push(payload);
        }
        return chain;
      },
      insert: (payload: Record<string, unknown>) => {
        b.inserted = true;
        b.last = "insert";
        if (table === "messages") {
          state.messageInserts.push(payload);
        }
        return chain;
      },
      delete: () => {
        b.last = "delete";
        return chain;
      },
    };

    function computeResult(): Record<string, unknown> {
      if (b.inserted) {
        if (table === "messages" && b.last === "single") {
          return { data: { id: "msg-1" }, error: null };
        }
        return { error: null };
      }
      if (b.updated) return { error: null };
      if (table === "conversations") {
        // findOrCreate/select of the conversation the agent is replying to.
        return {
          data: {
            id: "conv-1",
            user_id: "user-1",
            contact: { id: "contact-1", phone: "16505551234" },
          },
          error: null,
        };
      }
      if (table === "whatsapp_config") {
        return {
          data: {
            id: "cfg-1",
            phone_number_id: "pn-1",
            access_token: "encrypted",
            status: "connected",
          },
          error: null,
        };
      }
      if (table === "messages") {
        // Reply-target lookup — no parent for these tests.
        return { data: null, error: null };
      }
      return { data: [], error: null };
    }

    return chain;
  }

  function makeSupabase() {
    return {
      auth: {
        getUser: () =>
          Promise.resolve({ data: { user: { id: "user-1" } }, error: null }),
      },
      from(table: string) {
        return makeChain(table);
      },
    };
  }

  return {
    state,
    makeSupabase,
    reset() {
      state.conversationUpdates = [];
      state.messageInserts = [];
    },
  };
});

// Mock every module the send route pulls in so the test exercises only
// the route's own decision logic, never a real Meta/Supabase service.
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => mockState.makeSupabase()),
}));

vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: vi.fn(() => mockState.makeSupabase()),
}));

vi.mock("@/lib/whatsapp/meta-api", () => ({
  sendTextMessage: vi.fn(async () => ({ messageId: "wa-1" })),
  sendTemplateMessage: vi.fn(async () => ({ messageId: "wa-1" })),
}));

vi.mock("@/lib/whatsapp/encryption", () => ({
  decrypt: vi.fn(() => "plain-token"),
  encrypt: vi.fn(() => "encrypted"),
  isLegacyFormat: vi.fn(() => false),
}));

vi.mock("@/lib/whatsapp/phone-utils", () => ({
  sanitizePhoneForMeta: vi.fn((phone: string) => phone),
  isValidE164: vi.fn(() => true),
  phoneVariants: vi.fn((phone: string) => [phone]),
  isRecipientNotAllowedError: vi.fn(() => false),
}));

import { POST } from "./route";

function sendRequest(overrides: Record<string, unknown> = {}): Request {
  return new Request("http://localhost/api/whatsapp/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversation_id: "conv-1",
      message_type: "text",
      content_text: "Thank you...",
      ...overrides,
    }),
  });
}

beforeEach(() => {
  mockState.reset();
  __resetRateLimitForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/whatsapp/send — unread/read state on agent reply", () => {
  // TEST 3 — the agent's reply marks the conversation read at the source
  // of truth: the send route's conversation UPDATE resets unread_count to 0.
  it("clears unread_count when the agent replies", async () => {
    const res = await POST(sendRequest());
    expect(res.status).toBe(200);

    const payload = await res.json();
    expect(payload.success).toBe(true);

    const convUpdate = mockState.state.conversationUpdates.find(
      (u) => u["last_message_text"] === "Thank you...",
    );
    expect(convUpdate).toBeDefined();
    expect(convUpdate!["unread_count"]).toBe(0);
  });

  // TEST 4 — the outbound path never writes an unread increment. The
  // outgoing message is stored as an agent message and the ONLY unread
  // write the send route makes is the reset to 0.
  it("stores the reply as an agent message and never increments unread", async () => {
    const res = await POST(sendRequest());
    expect(res.status).toBe(200);

    const msgInsert = mockState.state.messageInserts[0];
    expect(msgInsert).toBeDefined();
    expect(msgInsert!["sender_type"]).toBe("agent");

    const unreadWrites = mockState.state.conversationUpdates.filter(
      (u) => u["unread_count"] !== undefined,
    );
    expect(unreadWrites.length).toBeGreaterThan(0);
    for (const u of unreadWrites) {
      expect(u["unread_count"]).toBe(0);
    }
  });

  // TEST 9 — multiple consecutive agent replies keep the conversation read.
  it("keeps the conversation read across multiple replies", async () => {
    const replies = ["Hi", "How can I help?", "Are you looking for our service?"];
    for (const text of replies) {
      const res = await POST(sendRequest({ content_text: text }));
      expect(res.status).toBe(200);
    }

    const updates = mockState.state.conversationUpdates.filter(
      (u) => u["last_message_text"] !== undefined,
    );
    expect(updates).toHaveLength(replies.length);
    for (const u of updates) {
      expect(u["unread_count"]).toBe(0);
    }
  });
});
