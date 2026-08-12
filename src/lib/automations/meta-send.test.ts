import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encrypt } from "@/lib/whatsapp/encryption";
import { engineSendTemplate, engineSendText } from "./meta-send";

// Mock state shared by every supabase client the sender builds.
const dbMock = vi.hoisted(() => {
  const state = {
    messages: [] as Array<Record<string, unknown>>,
    convUpdates: [] as Array<Record<string, unknown>>,
  };

  function createMockClient() {
    return {
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
            state.messages.push(payload);
            return chain;
          },
          update: (payload: Record<string, unknown>) => {
            b.updated = true;
            b.last = "update";
            state.convUpdates.push(payload);
            return chain;
          },
          delete: () => {
            b.last = "delete";
            return chain;
          },
        };

        function computeResult(): Record<string, unknown> {
          if (b.inserted) return { error: null };
          if (b.updated) return { error: null };
          if (b.last === "single" || b.last === "maybeSingle") {
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
                  access_token: encrypt("meta-access-token"),
                },
                error: null,
              };
            }
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
      state.messages = [];
      state.convUpdates = [];
    },
    createMockClient,
  };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => dbMock.createMockClient()),
}));

vi.mock("@/lib/whatsapp/meta-api", () => ({
  sendTemplateMessage: vi.fn(async () => ({ messageId: "wamid.template.1" })),
  sendTextMessage: vi.fn(async () => ({ messageId: "wamid.text.1" })),
}));

beforeEach(() => {
  dbMock.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const BASE = {
  userId: "user-1",
  conversationId: "conv-1",
  contactId: "contact-1",
};

describe("engineSendTemplate — automation outbound template persistence", () => {
  it("persists the rendered template body as content_text", async () => {
    await engineSendTemplate({
      ...BASE,
      templateName: "independence_offer",
      params: [{ key: "customer_name", value: "Chetan" }],
      contentText:
        "Hi Chetan, we've received a request for your 🇮🇳 THIS INDEPENDENCE DAY.",
    });

    expect(dbMock.state.messages).toHaveLength(1);
    const row = dbMock.state.messages[0];
    expect(row.content_type).toBe("template");
    expect(row.sender_type).toBe("bot");
    expect(row.template_name).toBe("independence_offer");
    expect(row.message_id).toBe("wamid.template.1");
    expect(row.content_text).toBe(
      "Hi Chetan, we've received a request for your 🇮🇳 THIS INDEPENDENCE DAY.",
    );
  });

  it("keeps the pre-fix fallback (content_text null) when no rendered body is supplied", async () => {
    await engineSendTemplate({
      ...BASE,
      templateName: "legacy_template",
    });

    const row = dbMock.state.messages[0];
    expect(row.content_type).toBe("template");
    // Legacy automation runs that can't resolve the body still store the
    // row; the Inbox shows the template pill rather than crashing.
    expect(row.content_text).toBeNull();
  });

  it("updates the conversation preview with the template name", async () => {
    await engineSendTemplate({
      ...BASE,
      templateName: "independence_offer",
      contentText: "Hi Chetan",
    });

    expect(dbMock.state.convUpdates).toHaveLength(1);
    expect(dbMock.state.convUpdates[0].last_message_text).toBe(
      "[template:independence_offer]",
    );
  });
});

describe("engineSendText — automation outbound text persistence unchanged", () => {
  it("persists the plain text as content_text (content_type text)", async () => {
    await engineSendText({
      ...BASE,
      text: "Hello from an automation",
    });

    expect(dbMock.state.messages).toHaveLength(1);
    expect(dbMock.state.messages[0].content_type).toBe("text");
    expect(dbMock.state.messages[0].sender_type).toBe("bot");
    expect(dbMock.state.messages[0].content_text).toBe(
      "Hello from an automation",
    );
    expect(dbMock.state.messages[0].template_name).toBeNull();
  });
});
