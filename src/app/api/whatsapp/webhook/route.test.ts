import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseMessageContent,
  processMessage,
  type WhatsAppMessage,
} from "./route";

// Shared, resettable mock state — `vi.mock` factories are hoisted above
// imports, so anything they touch must live in `vi.hoisted()`.
const supabaseMock = vi.hoisted(() => {
  const state = {
    inserts: [] as Array<{ table: string; payload: Record<string, unknown> }>,
    updates: [] as Array<{ table: string; payload: Record<string, unknown> }>,
  };

  function createMockClient() {
    return {
      from(table: string) {
        const b = {
          inserted: false,
          updated: false,
          countQuery: false,
          last: "select",
        };

        const chain = {
          _table: table,
          // Make the chain awaitable. The resolved value is computed from
          // the chain's table + terminal method, mirroring what Supabase's
          // builder returns ({ data, error } / { count, error }).
          then(onFulfilled: (v: unknown) => void) {
            return Promise.resolve(onFulfilled(computeResult()));
          },
          select: (...args: unknown[]) => {
            b.countQuery =
              typeof args[1] === "object" && args[1] !== null;
            b.last = "select";
            return chain;
          },
          eq: () => {
            b.last = "eq";
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
            state.updates.push({ table, payload });
            return chain;
          },
          insert: (payload: Record<string, unknown>) => {
            b.inserted = true;
            b.last = "insert";
            state.inserts.push({ table, payload });
            return chain;
          },
          delete: () => {
            b.last = "delete";
            return chain;
          },
        };

        function computeResult(): Record<string, unknown> {
          if (b.inserted) {
            if (b.last === "single") {
              if (table === "contacts") {
                return {
                  data: { id: "contact-1", phone: "16505551234", name: "Test User" },
                  error: null,
                };
              }
              if (table === "conversations") {
                return { data: { id: "conv-1", unread_count: 0 }, error: null };
              }
            }
            return { error: null };
          }
          if (b.updated) return { error: null };
          if (b.countQuery) return { count: 0, error: null };
          if (b.last === "single" || b.last === "maybeSingle") {
            return {
              data: null,
              error:
                table === "conversations" ? { message: "not found" } : null,
            };
          }
          return { data: [], error: null };
        }

        return chain;
      },
    };
  }

  return {
    state,
    reset() {
      state.inserts = [];
      state.updates = [];
    },
    createMockClient,
  };
});

// Every supabase client in the app (webhook route, flows engine,
// automations engine) calls createClient from this package, so a single
// mock covers the whole pipeline that processMessage drives.
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => supabaseMock.createMockClient()),
}));

const CONTACT = { profile: { name: "Kerry Fisher" }, wa_id: "16505551234" };

// Realistic Meta payload for a template quick-reply button tap.
function buttonReply(text: string, payload: string): WhatsAppMessage {
  return {
    from: "16505551234",
    id: `wamid.button.${text.toLowerCase()}`,
    timestamp: "1714510003",
    type: "button",
    button: { text, payload },
    context: { id: "wamid.HBgLMTY0NjcwNDM1OTUVAgARGBJBM0Y4RUU0RUNFQkFDMjYzQUMA" },
  };
}

beforeEach(() => {
  supabaseMock.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseMessageContent — template quick-reply button taps", () => {
  it("extracts the tapped title for a YES button", async () => {
    const result = await parseMessageContent(
      buttonReply("Yes", "yes-payload"),
      "token",
    );
    expect(result.contentText).toBe("Yes");
    // Normalized into the text representation, not a new message type.
    expect(result.interactiveReplyId).toBeNull();
    expect(result.mediaUrl).toBeNull();
    expect(result.mediaType).toBeNull();
  });

  it("extracts the tapped title for a NO button", async () => {
    const result = await parseMessageContent(
      buttonReply("No", "no-payload"),
      "token",
    );
    expect(result.contentText).toBe("No");
    expect(result.interactiveReplyId).toBeNull();
  });

  it("handles arbitrary button titles (Confirm, Subscribe, ...)", async () => {
    for (const title of ["Confirm", "Subscribe", "Reject"]) {
      const result = await parseMessageContent(
        buttonReply(title, `${title.toLowerCase()}-payload`),
        "token",
      );
      expect(result.contentText).toBe(title);
    }
  });

  it("does not crash on a malformed button payload and falls back safely", async () => {
    const missingText = await parseMessageContent(
      { ...buttonReply("Yes", ""), button: { text: "", payload: "x" } },
      "token",
    );
    expect(missingText.contentText).toBeNull();

    const noButton = await parseMessageContent(
      {
        from: "16505551234",
        id: "wamid.button.missing",
        timestamp: "1714510003",
        type: "button",
      },
      "token",
    );
    expect(noButton.contentText).toBeNull();
  });
});

describe("parseMessageContent — existing types unchanged", () => {
  it("keeps normal text messages intact", async () => {
    const result = await parseMessageContent(
      {
        from: "16505551234",
        id: "wamid.text.1",
        timestamp: "1714510003",
        type: "text",
        text: { body: "Yes" },
      },
      "token",
    );
    expect(result.contentText).toBe("Yes");
  });

  it("keeps interactive button_reply taps intact (reply id + title)", async () => {
    const result = await parseMessageContent(
      {
        from: "16505551234",
        id: "wamid.interactive.1",
        timestamp: "1714510003",
        type: "interactive",
        interactive: {
          type: "button_reply",
          button_reply: { id: "yes", title: "Yes" },
        },
      },
      "token",
    );
    expect(result.contentText).toBe("Yes");
    expect(result.interactiveReplyId).toBe("yes");
  });

  it("keeps the unsupported-type fallback for genuinely unknown types", async () => {
    const result = await parseMessageContent(
      {
        from: "16505551234",
        id: "wamid.unknown.1",
        timestamp: "1714510003",
        type: "order",
      },
      "token",
    );
    expect(result.contentText).toBe("[Unsupported message type: order]");
  });
});

describe("processMessage — full inbound pipeline for button replies", () => {
  it("stores a YES button reply as a normal text message in the conversation", async () => {
    await processMessage(buttonReply("Yes", "yes-payload"), CONTACT, "user-1", "token");

    const messageInsert = supabaseMock.state.inserts.find(
      (i) => i.table === "messages",
    );
    expect(messageInsert).toBeDefined();
    expect(messageInsert!.payload.content_text).toBe("Yes");
    expect(messageInsert!.payload.content_type).toBe("text");
    expect(messageInsert!.payload.sender_type).toBe("customer");
    expect(messageInsert!.payload.message_id).toBe("wamid.button.yes");
    expect(messageInsert!.payload.interactive_reply_id).toBeNull();

    const convUpdate = supabaseMock.state.updates.find(
      (u) => u.table === "conversations",
    );
    expect(convUpdate).toBeDefined();
    expect(convUpdate!.payload.last_message_text).toBe("Yes");
  });

  it("stores a NO button reply as a normal text message in the conversation", async () => {
    await processMessage(buttonReply("No", "no-payload"), CONTACT, "user-1", "token");

    const messageInsert = supabaseMock.state.inserts.find(
      (i) => i.table === "messages",
    );
    expect(messageInsert).toBeDefined();
    expect(messageInsert!.payload.content_text).toBe("No");
    expect(messageInsert!.payload.content_type).toBe("text");
    expect(messageInsert!.payload.interactive_reply_id).toBeNull();

    const convUpdate = supabaseMock.state.updates.find(
      (u) => u.table === "conversations",
    );
    expect(convUpdate!.payload.last_message_text).toBe("No");
  });

  it("handles an arbitrary Confirm title end-to-end", async () => {
    await processMessage(buttonReply("Confirm", "confirm-payload"), CONTACT, "user-1", "token");

    const messageInsert = supabaseMock.state.inserts.find(
      (i) => i.table === "messages",
    );
    expect(messageInsert!.payload.content_text).toBe("Confirm");
  });
});
