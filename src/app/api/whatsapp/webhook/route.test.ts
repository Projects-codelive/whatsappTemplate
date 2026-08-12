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
    // Overridable id returned when the webhook resolves a reply's
    // context.id (the original template's Meta message id) to an internal
    // parent row. Defaults to "parent-1"; tests set it to a specific
    // pre-existing template row to prove the reply links to the original.
    lookupParentId: undefined as string | undefined,
    // When true the message_id lookup returns "parent not found", forcing
    // the webhook down the broadcast-reconstruction path.
    lookupParentMissing: false,
    // Broadcast data returned by the reconstruction lookups. When set, the
    // webhook rebuilds the original template from these rows instead of
    // storing the reply orphaned.
    broadcastRecipient: undefined as
      | { broadcast_id: string; sent_at: string }
      | undefined,
    broadcast: undefined as
      | { user_id: string; template_name: string; template_variables?: Record<string, unknown> }
      | undefined,
    templateBody: undefined as string | undefined,
    customValues: [] as Array<{ custom_field_id: string; value: string }>,
  };

  function createMockClient() {
    return {
      from(table: string) {
        const b = {
          inserted: false,
          updated: false,
          countQuery: false,
          last: "select",
          // Track the active eq filters so the mock can return a parent
          // row for the webhook's context.id → internal-id lookup.
          filters: {} as Record<string, unknown>,
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
              if (table === "messages") {
                // The broadcast-template reconstruction insert returns the
                // rebuilt row's id so the reply can link to it.
                return { data: { id: "restored-tpl-1" }, error: null };
              }
            }
            return { error: null };
          }
          if (b.updated) return { error: null };
          if (b.countQuery) return { count: 0, error: null };
          if (b.last === "single" || b.last === "maybeSingle") {
            // lookupInternalIdByMetaId resolves a reply's context.id (a
            // Meta message id) to the internal parent message row. Return
            // a parent id for those lookups so the button-reply tests can
            // assert reply_to_message_id gets populated.
            if (table === "messages" && b.filters.message_id) {
              if (state.lookupParentMissing) return { data: null, error: null };
              return { data: { id: state.lookupParentId ?? "parent-1" }, error: null };
            }
            // Broadcast-template reconstruction lookups.
            if (table === "broadcast_recipients" && b.filters.whatsapp_message_id) {
              return { data: state.broadcastRecipient ?? null, error: null };
            }
            if (table === "broadcasts" && state.broadcast) {
              return { data: state.broadcast, error: null };
            }
            return {
              data: null,
              error:
                table === "conversations" ? { message: "not found" } : null,
            };
          }
          // Table-scoped lookups that end in eq/limit (not single).
          if (table === "message_templates") {
            return {
              data: state.templateBody
                ? [{ body_text: state.templateBody }]
                : [],
              error: null,
            };
          }
          if (table === "contact_custom_values") {
            return { data: state.customValues, error: null };
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
      state.lookupParentId = undefined;
      state.lookupParentMissing = false;
      state.broadcastRecipient = undefined;
      state.broadcast = undefined;
      state.templateBody = undefined;
      state.customValues = [];
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
  it("stores a YES template button reply as an interactive reply in the conversation", async () => {
    await processMessage(buttonReply("Yes", "yes-payload"), CONTACT, "user-1", "token");

    const messageInsert = supabaseMock.state.inserts.find(
      (i) => i.table === "messages",
    );
    expect(messageInsert).toBeDefined();
    expect(messageInsert!.payload.content_text).toBe("Yes");
    // Template button taps are stored as 'interactive' so the inbox
    // renders them with the button-reply affordance.
    expect(messageInsert!.payload.content_type).toBe("interactive");
    expect(messageInsert!.payload.sender_type).toBe("customer");
    expect(messageInsert!.payload.message_id).toBe("wamid.button.yes");
    expect(messageInsert!.payload.interactive_reply_id).toBeNull();

    const convUpdate = supabaseMock.state.updates.find(
      (u) => u.table === "conversations",
    );
    expect(convUpdate).toBeDefined();
    expect(convUpdate!.payload.last_message_text).toBe("Yes");
  });

  it("stores a NO template button reply as an interactive reply in the conversation", async () => {
    await processMessage(buttonReply("No", "no-payload"), CONTACT, "user-1", "token");

    const messageInsert = supabaseMock.state.inserts.find(
      (i) => i.table === "messages",
    );
    expect(messageInsert).toBeDefined();
    expect(messageInsert!.payload.content_text).toBe("No");
    expect(messageInsert!.payload.content_type).toBe("interactive");
    expect(messageInsert!.payload.interactive_reply_id).toBeNull();

    const convUpdate = supabaseMock.state.updates.find(
      (u) => u.table === "conversations",
    );
    expect(convUpdate!.payload.last_message_text).toBe("No");
  });

  it("associates a button reply with the original template via the context message id", async () => {
    await processMessage(buttonReply("Yes", "yes-payload"), CONTACT, "user-1", "token");

    const messageInsert = supabaseMock.state.inserts.find(
      (i) => i.table === "messages",
    );
    // lookupInternalIdByMetaId resolves message.context.id (the original
    // template's Meta message id) to the internal parent row id, which is
    // persisted as reply_to_message_id so the inbox can quote the original
    // template bubble.
    expect(messageInsert!.payload.reply_to_message_id).toBe("parent-1");
  });

  it("persists a button reply as exactly one message row (no duplicates)", async () => {
    await processMessage(buttonReply("Yes", "yes-payload"), CONTACT, "user-1", "token");

    const messageInserts = supabaseMock.state.inserts.filter(
      (i) => i.table === "messages",
    );
    expect(messageInserts).toHaveLength(1);
  });

  it("uses the incoming message timestamp so the reply keeps chronological order", async () => {
    await processMessage(buttonReply("Yes", "yes-payload"), CONTACT, "user-1", "token");

    const messageInsert = supabaseMock.state.inserts.find(
      (i) => i.table === "messages",
    );
    // The thread orders by created_at, which is derived from the Meta
    // timestamp (1714510003) — not NOW(), so order is preserved.
    expect(messageInsert!.payload.created_at).toBe(
      new Date(1714510003 * 1000).toISOString(),
    );
  });

  it("falls back to a standalone reply bubble when the referenced parent is missing", async () => {
    const withoutContext: WhatsAppMessage = {
      from: "16505551234",
      id: "wamid.button.no",
      timestamp: "1714510003",
      type: "button",
      button: { text: "No", payload: "no-payload" },
    };
    await processMessage(withoutContext, CONTACT, "user-1", "token");

    const messageInsert = supabaseMock.state.inserts.find(
      (i) => i.table === "messages",
    );
    expect(messageInsert).toBeDefined();
    expect(messageInsert!.payload.content_text).toBe("No");
    expect(messageInsert!.payload.content_type).toBe("interactive");
    // No context id → no parent resolution → no quote; the reply still
    // renders on its own without crashing.
    expect(messageInsert!.payload.reply_to_message_id).toBeNull();
  });

  it("handles an arbitrary Confirm title end-to-end", async () => {
    await processMessage(buttonReply("Confirm", "confirm-payload"), CONTACT, "user-1", "token");

    const messageInsert = supabaseMock.state.inserts.find(
      (i) => i.table === "messages",
    );
    expect(messageInsert!.payload.content_text).toBe("Confirm");
    expect(messageInsert!.payload.content_type).toBe("interactive");
  });

  it("represents BOTH the original template and the button reply as separate messages, without duplicating the template", async () => {
    // Simulate the row the send route persisted when the agent sent the
    // outbound template. The reply must link to THIS row, and the webhook
    // must not create a second copy of the template.
    supabaseMock.state.lookupParentId = "tpl-1";
    const templateRow = {
      id: "tpl-1",
      conversation_id: "conv-1",
      sender_type: "agent",
      content_type: "template",
      content_text:
        "Hi Chetan, we've received a request for your 🇮🇳 THIS INDEPENDENCE DAY, INVEST IN YOUR KNOWLEDGE.",
      template_name: "independence_offer",
      message_id: "wamid.template.abc",
      status: "sent",
      created_at: new Date(1714500000 * 1000).toISOString(),
    };

    await processMessage(buttonReply("Yes", "yes-payload"), CONTACT, "user-1", "token");

    // The webhook inserts exactly one message row — the reply. The
    // original template is NOT re-inserted (no duplicate template rows).
    const messageInserts = supabaseMock.state.inserts.filter(
      (i) => i.table === "messages",
    );
    expect(messageInserts).toHaveLength(1);
    expect(messageInserts[0].payload.content_type).toBe("interactive");
    expect(messageInserts[0].payload.content_text).toBe("Yes");
    expect(messageInserts[0].payload.sender_type).toBe("customer");

    // The reply references the ORIGINAL template row (not a new one).
    expect(messageInserts[0].payload.reply_to_message_id).toBe("tpl-1");

    // Conversation history the Inbox thread would fetch and render:
    // [original template, button reply] — two distinct messages.
    const fetched = [templateRow, messageInserts[0].payload];
    expect(fetched.map((m) => m.content_type)).toEqual(["template", "interactive"]);
    expect(fetched.map((m) => m.content_text)).toEqual([
      "Hi Chetan, we've received a request for your 🇮🇳 THIS INDEPENDENCE DAY, INVEST IN YOUR KNOWLEDGE.",
      "Yes",
    ]);

    // Chronological order: template (10:00) before the reply (10:02).
    const templateTime = new Date(templateRow.created_at).getTime();
    const replyTime = new Date(messageInserts[0].payload.created_at as string).getTime();
    expect(replyTime).toBeGreaterThan(templateTime);
  });

  it("keeps a NO button reply linked to the original template without duplicating it", async () => {
    supabaseMock.state.lookupParentId = "tpl-1";
    const templateRow = {
      id: "tpl-1",
      conversation_id: "conv-1",
      sender_type: "agent",
      content_type: "template",
      content_text: "Hi Chetan, welcome to Market Education.",
      template_name: "independence_offer",
      message_id: "wamid.template.abc",
      status: "sent",
      created_at: new Date(1714500000 * 1000).toISOString(),
    };

    await processMessage(buttonReply("No", "no-payload"), CONTACT, "user-1", "token");

    const messageInserts = supabaseMock.state.inserts.filter(
      (i) => i.table === "messages",
    );
    expect(messageInserts).toHaveLength(1);
    expect(messageInserts[0].payload.content_text).toBe("No");
    expect(messageInserts[0].payload.content_type).toBe("interactive");
    expect(messageInserts[0].payload.reply_to_message_id).toBe("tpl-1");

    const fetched = [templateRow, messageInserts[0].payload];
    expect(fetched.map((m) => m.content_text)).toEqual([
      "Hi Chetan, welcome to Market Education.",
      "No",
    ]);
  });
});

describe("processMessage — broadcast template reconstruction", () => {
  // The context id the button-reply fixture points at — the Meta message
  // id of the template the customer tapped.
  const CONTEXT_ID =
    "wamid.HBgLMTY0NjcwNDM1OTUVAgARGBJBM0Y4RUU0RUNFQkFDMjYzQUMA";

  // Broadcast sends never persist a messages row. When the customer taps
  // a button, the webhook must rebuild the original template from the
  // broadcast data so the inbox shows it above the reply.
  function setupBroadcast(body: string) {
    supabaseMock.state.lookupParentMissing = true;
    supabaseMock.state.broadcastRecipient = {
      broadcast_id: "bc-1",
      sent_at: "2024-04-30T09:59:00.000Z",
    };
    supabaseMock.state.broadcast = {
      user_id: "user-1",
      template_name: "independence_offer",
      template_variables: {
        customer_name: { type: "static", value: "Chetan" },
      },
    };
    supabaseMock.state.templateBody = body;
    supabaseMock.state.customValues = [];
  }

  it("reconstructs the original broadcast template above a YES button reply", async () => {
    setupBroadcast("Hi {{customer_name}}, welcome to Market Education.");
    await processMessage(
      buttonReply("Yes", "yes-payload"),
      CONTACT,
      "user-1",
      "token",
    );

    const messageInserts = supabaseMock.state.inserts.filter(
      (i) => i.table === "messages",
    );
    // Original template row (reconstructed) + the customer's reply row.
    expect(messageInserts).toHaveLength(2);

    const template = messageInserts[0].payload;
    expect(template.content_type).toBe("template");
    expect(template.sender_type).toBe("agent");
    expect(template.message_id).toBe(CONTEXT_ID);
    expect(template.template_name).toBe("independence_offer");
    expect(template.status).toBe("delivered");
    // Sorted above the reply: created_at is the broadcast send time.
    expect(template.created_at).toBe("2024-04-30T09:59:00.000Z");
    // The exact rendered body the customer received — NOT fabricated from
    // the tapped "Yes" label.
    expect(template.content_text).toBe(
      "Hi Chetan, welcome to Market Education.",
    );

    const reply = messageInserts[1].payload;
    expect(reply.content_type).toBe("interactive");
    expect(reply.content_text).toBe("Yes");
    expect(reply.sender_type).toBe("customer");
    // The reply links to the reconstructed template row.
    expect(reply.reply_to_message_id).toBe("restored-tpl-1");
  });

  it("reconstructs the original broadcast template above a NO button reply", async () => {
    setupBroadcast("Hi {{customer_name}}, welcome to Market Education.");
    await processMessage(
      buttonReply("No", "no-payload"),
      CONTACT,
      "user-1",
      "token",
    );

    const messageInserts = supabaseMock.state.inserts.filter(
      (i) => i.table === "messages",
    );
    expect(messageInserts).toHaveLength(2);
    expect(messageInserts[0].payload.content_type).toBe("template");
    expect(messageInserts[0].payload.content_text).toBe(
      "Hi Chetan, welcome to Market Education.",
    );
    expect(messageInserts[1].payload.content_text).toBe("No");
    expect(messageInserts[1].payload.reply_to_message_id).toBe(
      "restored-tpl-1",
    );
  });

  it("resolves contact-field and custom-field variables when rebuilding the body", async () => {
    supabaseMock.state.lookupParentMissing = true;
    supabaseMock.state.broadcastRecipient = {
      broadcast_id: "bc-1",
      sent_at: "2024-04-30T09:59:00.000Z",
    };
    supabaseMock.state.broadcast = {
      user_id: "user-1",
      template_name: "independence_offer",
      template_variables: {
        "1": { type: "field", value: "name" },
        "2": { type: "custom_field", value: "cf-9" },
      },
    };
    supabaseMock.state.templateBody = "Hi {{1}}, your plan is {{2}}.";
    supabaseMock.state.customValues = [
      { custom_field_id: "cf-9", value: "Premium" },
    ];

    await processMessage(
      buttonReply("Yes", "yes-payload"),
      CONTACT,
      "user-1",
      "token",
    );

    const template = supabaseMock.state.inserts
      .filter((i) => i.table === "messages")
      .find((i) => i.payload.content_type === "template");
    // Contact name comes from the mock contact row ("Test User"); the
    // custom field resolves from contact_custom_values.
    expect(template!.payload.content_text).toBe(
      "Hi Test User, your plan is Premium.",
    );
  });

  it("stores the reply standalone when the referenced message was not a broadcast", async () => {
    // No parent message row and no broadcast recipient match — the reply
    // must still be stored on its own without crashing.
    supabaseMock.state.lookupParentMissing = true;
    await processMessage(
      buttonReply("Yes", "yes-payload"),
      CONTACT,
      "user-1",
      "token",
    );

    const messageInserts = supabaseMock.state.inserts.filter(
      (i) => i.table === "messages",
    );
    expect(messageInserts).toHaveLength(1);
    expect(messageInserts[0].payload.content_type).toBe("interactive");
    expect(messageInserts[0].payload.content_text).toBe("Yes");
    expect(messageInserts[0].payload.reply_to_message_id).toBeNull();
  });
});

describe("processMessage — manually typed text stays a normal text message", () => {
  function typedText(text: string): WhatsAppMessage {
    return {
      from: "16505551234",
      id: `wamid.text.${text.toLowerCase()}`,
      timestamp: "1714510003",
      type: "text",
      text: { body: text },
    };
  }

  it("keeps a manually typed 'Yes' as a plain text message", async () => {
    await processMessage(typedText("Yes"), CONTACT, "user-1", "token");

    const messageInsert = supabaseMock.state.inserts.find(
      (i) => i.table === "messages",
    );
    expect(messageInsert).toBeDefined();
    expect(messageInsert!.payload.content_text).toBe("Yes");
    expect(messageInsert!.payload.content_type).toBe("text");
    expect(messageInsert!.payload.interactive_reply_id).toBeNull();
    expect(messageInsert!.payload.reply_to_message_id).toBeNull();
  });

  it("keeps a manually typed 'No' as a plain text message", async () => {
    await processMessage(typedText("No"), CONTACT, "user-1", "token");

    const messageInsert = supabaseMock.state.inserts.find(
      (i) => i.table === "messages",
    );
    expect(messageInsert).toBeDefined();
    expect(messageInsert!.payload.content_text).toBe("No");
    expect(messageInsert!.payload.content_type).toBe("text");
    expect(messageInsert!.payload.interactive_reply_id).toBeNull();
    expect(messageInsert!.payload.reply_to_message_id).toBeNull();
  });
});
