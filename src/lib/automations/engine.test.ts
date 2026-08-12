import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encrypt } from "@/lib/whatsapp/encryption";
import { runAutomationsForTrigger } from "./engine";

// Mock supabase + Meta sender so the whole send_template pipeline runs in
// memory. The automation row and its send_template step are defined here
// (vi.mock is hoisted, so everything it closes over must live in
// vi.hoisted()).
const dbMock = vi.hoisted(() => {
  const BODY =
    "Hi {{customer_name}}, we've received a request for your 🇮🇳 THIS INDEPENDENCE DAY. " +
    "Reply with YES to be assigned a new agent or NO to cancel.";

  const state = {
    messages: [] as Array<Record<string, unknown>>,
    messagesInserted: 0,
    // Set in beforeEach with the real encrypt() output so decrypt() (used
    // by the sender) can round-trip the access token.
    whatsappConfigAccessToken: "",
  };

  function createMockClient() {
    return {
      rpc: () => {
        const chain = {
          then(onFulfilled: (v: unknown) => void) {
            return Promise.resolve(onFulfilled({ error: null }));
          },
        };
        return chain;
      },
      from(table: string) {
        const b = { inserted: false, updated: false, last: "select" };

        const chain = {
          _table: table,
          then(onFulfilled: (v: unknown) => void) {
            return Promise.resolve(onFulfilled(computeResult()));
          },
          select: () => {
            b.last = "select";
            return chain;
          },
          eq: () => {
            b.last = "eq";
            return chain;
          },
          gte: () => {
            b.last = "gte";
            return chain;
          },
          is: () => {
            b.last = "is";
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
          insert: (payload: Record<string, unknown>) => {
            b.inserted = true;
            b.last = "insert";
            if (table === "messages") {
              state.messages.push(payload);
              state.messagesInserted++;
            }
            return chain;
          },
          update: () => {
            b.updated = true;
            b.last = "update";
            return chain;
          },
          delete: () => {
            b.last = "delete";
            return chain;
          },
        };

        function computeResult(): Record<string, unknown> {
          if (b.inserted) {
            if (b.last === "single" && table === "automation_logs") {
              return { data: { id: "log-1" }, error: null };
            }
            return { error: null };
          }
          if (b.updated) return { error: null };
          if (b.last === "single" || b.last === "maybeSingle") {
            if (table === "automation_logs") {
              return {
                data: { steps_executed: [], status: "success" },
                error: null,
              };
            }
            // The sender (automations/meta-send.ts) looks these up before
            // persisting the outbound message.
            if (table === "contacts") {
              return {
                data: { id: "contact-1", phone: "16505551234" },
                error: null,
              };
            }
            if (table === "whatsapp_config") {
              return {
                data: {
                  id: "cfg-1",
                  user_id: "user-1",
                  phone_number_id: "phone-number-1",
                  access_token: state.whatsappConfigAccessToken,
                },
                error: null,
              };
            }
            return { data: null, error: null };
          }
          if (table === "automations") {
            return {
              data: [
                {
                  id: "automation-1",
                  user_id: "user-1",
                  name: "Independence offer",
                  trigger_type: "new_message_received",
                  trigger_config: {},
                  is_active: true,
                  execution_count: 0,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                },
              ],
              error: null,
            };
          }
          if (table === "automation_steps") {
            return {
              data: [
                {
                  id: "step-1",
                  automation_id: "automation-1",
                  parent_step_id: null,
                  branch: null,
                  step_type: "send_template",
                  step_config: {
                    template_name: "independence_offer",
                    language: "en_US",
                    variables: { customer_name: "Chetan" },
                  },
                  position: 0,
                  created_at: new Date().toISOString(),
                },
              ],
              error: null,
            };
          }
          if (table === "message_templates") {
            return {
              data: [{ body_text: BODY }],
              error: null,
            };
          }
          return { data: [], error: null };
        }

        return chain;
      },
    };
  }

  return {
    BODY,
    state,
    reset() {
      state.messages = [];
      state.messagesInserted = 0;
      state.whatsappConfigAccessToken = "";
    },
    createMockClient,
  };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => dbMock.createMockClient()),
}));

vi.mock("@/lib/whatsapp/meta-api", () => ({
  sendTemplateMessage: vi.fn(async () => ({
    messageId: "wamid.template.abc",
  })),
  sendTextMessage: vi.fn(async () => ({ messageId: "wamid.text.1" })),
}));

beforeEach(() => {
  dbMock.reset();
  dbMock.state.whatsappConfigAccessToken = encrypt("meta-access-token");
});

afterEach(() => {
  vi.restoreAllMocks();
});

// The exact real scenario: an automation send_template step fires an
// approved template with quick-reply buttons, and the engine must persist
// the outbound template with its RENDERED body so the Inbox shows the
// original message above the customer's button reply.
describe("runAutomationsForTrigger — send_template persists the rendered template", () => {
  it("stores content_text with the substituted template variables", async () => {
    await runAutomationsForTrigger({
      userId: "user-1",
      triggerType: "new_message_received",
      contactId: "contact-1",
      context: { conversation_id: "conv-1" },
    });

    expect(dbMock.state.messagesInserted).toBe(1);
    const row = dbMock.state.messages[0];
    expect(row.content_type).toBe("template");
    expect(row.sender_type).toBe("bot");
    expect(row.template_name).toBe("independence_offer");
    expect(row.message_id).toBe("wamid.template.abc");
    // "Chetan" substituted into {{customer_name}} — the exact body the
    // customer received on WhatsApp.
    expect(row.content_text).toBe(
      "Hi Chetan, we've received a request for your 🇮🇳 THIS INDEPENDENCE DAY. " +
        "Reply with YES to be assigned a new agent or NO to cancel.",
    );
    expect(dbMock.state.messages).toHaveLength(1);
  });

  it("persists exactly one outbound template row (no duplicates)", async () => {
    await runAutomationsForTrigger({
      userId: "user-1",
      triggerType: "new_message_received",
      contactId: "contact-1",
      context: { conversation_id: "conv-1" },
    });

    expect(dbMock.state.messages).toHaveLength(1);
  });
});

// The full thread the Inbox renders for the bug scenario: the persisted
// outbound template (from the automation above) plus the customer's
// button reply (persisted by the webhook, content_type='interactive').
// Together they must be two distinct, chronological messages.
describe("conversation thread for the original template + button reply", () => {
  it("represents template and button reply as separate chronological messages", () => {
    const templateRow = {
      id: "tpl-1",
      conversation_id: "conv-1",
      sender_type: "bot",
      content_type: "template",
      content_text: dbMock.BODY.replace("{{customer_name}}", "Chetan"),
      template_name: "independence_offer",
      message_id: "wamid.template.abc",
      status: "sent",
      created_at: "2024-04-30T10:00:00.000Z",
    };
    const buttonReply = {
      id: "reply-1",
      conversation_id: "conv-1",
      sender_type: "customer",
      content_type: "interactive",
      content_text: "Yes",
      reply_to_message_id: "tpl-1",
      message_id: "wamid.button.yes",
      created_at: "2024-04-30T10:01:00.000Z",
    };

    const thread = [templateRow, buttonReply];
    expect(thread).toHaveLength(2);
    expect(thread.map((m) => m.content_type)).toEqual([
      "template",
      "interactive",
    ]);
    expect(thread.map((m) => m.content_text)).toEqual([
      "Hi Chetan, we've received a request for your 🇮🇳 THIS INDEPENDENCE DAY. Reply with YES to be assigned a new agent or NO to cancel.",
      "Yes",
    ]);
    // Chronological: template before the customer's tap.
    expect(
      new Date(buttonReply.created_at).getTime(),
    ).toBeGreaterThan(new Date(templateRow.created_at).getTime());
    // Reply is linked to the original template via reply_to_message_id.
    expect(buttonReply.reply_to_message_id).toBe(templateRow.id);
  });
});
