import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  INTERACTIVE_LIMITS,
  sendInteractiveButtons,
  sendInteractiveList,
  sendTemplateMessage,
} from "./meta-api";

// All assertions in this file run BEFORE the network call. We stub fetch
// to a never-resolving mock so a test that accidentally falls through to
// the request body would hang (and fail) rather than silently hit
// graph.facebook.com.
const neverFetch = () =>
  new Promise<Response>(() => {
    /* intentionally never resolves */
  });

const BASE_ARGS = {
  phoneNumberId: "test-phone",
  accessToken: "test-token",
  to: "1234567890",
  bodyText: "Body text",
} as const;

describe("sendInteractiveButtons — validation", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(neverFetch));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects an empty buttons array", async () => {
    await expect(
      sendInteractiveButtons({ ...BASE_ARGS, buttons: [] }),
    ).rejects.toThrow(/1-3 buttons/);
  });

  it(`rejects more than ${INTERACTIVE_LIMITS.maxButtons} buttons (Meta cap)`, async () => {
    await expect(
      sendInteractiveButtons({
        ...BASE_ARGS,
        buttons: [
          { id: "a", title: "A" },
          { id: "b", title: "B" },
          { id: "c", title: "C" },
          { id: "d", title: "D" },
        ],
      }),
    ).rejects.toThrow(/1-3 buttons/);
  });

  it("rejects a button title longer than 20 chars (Meta cap)", async () => {
    await expect(
      sendInteractiveButtons({
        ...BASE_ARGS,
        buttons: [
          { id: "a", title: "x".repeat(INTERACTIVE_LIMITS.buttonTitleMaxLength + 1) },
        ],
      }),
    ).rejects.toThrow(/exceeds 20 chars/);
  });

  it("rejects a button missing its id", async () => {
    await expect(
      sendInteractiveButtons({
        ...BASE_ARGS,
        buttons: [{ id: "", title: "Choose me" }],
      }),
    ).rejects.toThrow(/missing id/);
  });

  it("rejects an empty body text", async () => {
    await expect(
      sendInteractiveButtons({
        ...BASE_ARGS,
        bodyText: "",
        buttons: [{ id: "a", title: "A" }],
      }),
    ).rejects.toThrow(/requires bodyText/);
  });

  it("rejects a header text over the limit", async () => {
    await expect(
      sendInteractiveButtons({
        ...BASE_ARGS,
        headerText: "x".repeat(INTERACTIVE_LIMITS.headerTextMaxLength + 1),
        buttons: [{ id: "a", title: "A" }],
      }),
    ).rejects.toThrow(/headerText exceeds/);
  });

  it("sends the right payload shape when all inputs are valid", async () => {
    let captured: { url: string; body: unknown; method: string } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        captured = {
          url,
          method: init.method ?? "GET",
          body: JSON.parse(String(init.body)),
        };
        return new Response(
          JSON.stringify({ messages: [{ id: "wamid.PASS" }] }),
          { status: 200 },
        );
      }),
    );

    const result = await sendInteractiveButtons({
      ...BASE_ARGS,
      headerText: "Hello",
      footerText: "Tap one",
      buttons: [
        { id: "yes", title: "Yes" },
        { id: "no", title: "No" },
      ],
    });

    expect(result).toEqual({ messageId: "wamid.PASS" });
    expect(captured).not.toBeNull();
    expect(captured!.method).toBe("POST");
    expect(captured!.url).toContain("test-phone/messages");
    expect(captured!.body).toMatchObject({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "1234567890",
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: "Body text" },
        header: { type: "text", text: "Hello" },
        footer: { text: "Tap one" },
        action: {
          buttons: [
            { type: "reply", reply: { id: "yes", title: "Yes" } },
            { type: "reply", reply: { id: "no", title: "No" } },
          ],
        },
      },
    });
  });
});

describe("sendInteractiveList — validation", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(neverFetch));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const ROW = { id: "r1", title: "Row 1" };

  it("rejects zero sections", async () => {
    await expect(
      sendInteractiveList({
        ...BASE_ARGS,
        buttonLabel: "Open",
        sections: [],
      }),
    ).rejects.toThrow(/1-10 sections/);
  });

  it(`rejects more than ${INTERACTIVE_LIMITS.maxListRowsTotal} rows total across sections (Meta cap)`, async () => {
    const rows = Array.from({ length: 11 }, (_, i) => ({
      id: `r${i}`,
      title: `Row ${i}`,
    }));
    await expect(
      sendInteractiveList({
        ...BASE_ARGS,
        buttonLabel: "Open",
        sections: [{ rows }],
      }),
    ).rejects.toThrow(/1-10 rows total/);
  });

  it("rejects a row title longer than 24 chars (Meta cap)", async () => {
    await expect(
      sendInteractiveList({
        ...BASE_ARGS,
        buttonLabel: "Open",
        sections: [
          {
            rows: [
              {
                id: "r1",
                title: "x".repeat(INTERACTIVE_LIMITS.listRowTitleMaxLength + 1),
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow(/exceeds 24 chars/);
  });

  it("rejects duplicate row ids across sections", async () => {
    await expect(
      sendInteractiveList({
        ...BASE_ARGS,
        buttonLabel: "Open",
        sections: [
          { rows: [{ id: "dupe", title: "First" }] },
          { rows: [{ id: "dupe", title: "Second" }] },
        ],
      }),
    ).rejects.toThrow(/duplicate row id/);
  });

  it("rejects an empty buttonLabel", async () => {
    await expect(
      sendInteractiveList({
        ...BASE_ARGS,
        buttonLabel: "",
        sections: [{ rows: [ROW] }],
      }),
    ).rejects.toThrow(/requires a buttonLabel/);
  });

  it("sends the right payload shape when valid", async () => {
    let captured: { body: unknown } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = { body: JSON.parse(String(init.body)) };
        return new Response(
          JSON.stringify({ messages: [{ id: "wamid.LIST" }] }),
          { status: 200 },
        );
      }),
    );

    const result = await sendInteractiveList({
      ...BASE_ARGS,
      buttonLabel: "Open menu",
      sections: [
        {
          title: "Orders",
          rows: [
            { id: "order_1", title: "Order #1", description: "€12" },
            { id: "order_2", title: "Order #2" },
          ],
        },
      ],
    });

    expect(result).toEqual({ messageId: "wamid.LIST" });
    expect(captured).not.toBeNull();
    expect(captured!.body).toMatchObject({
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: "Body text" },
        action: {
          button: "Open menu",
          sections: [
            {
              title: "Orders",
              rows: [
                { id: "order_1", title: "Order #1", description: "€12" },
                { id: "order_2", title: "Order #2" },
              ],
            },
          ],
        },
      },
    });
  });
});

describe("sendTemplateMessage — Meta error diagnostics", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("logs the complete Meta error response and throws all diagnostic fields", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: {
              message: "Invalid parameter",
              type: "OAuthException",
              code: 100,
              error_subcode: 2494073,
              error_data: {
                details:
                  'Parameter 2 ("product_name") contains invalid value',
              },
              fbtrace_id: "A1BC...",
            },
          }),
          { status: 400 },
        );
      }),
    );

    await expect(
      sendTemplateMessage({
        phoneNumberId: "test-phone",
        accessToken: "test-token",
        to: "1234567890",
        templateName: "cancellation_confirmation_edu",
        language: "en_US",
        params: ["Target 2 Hit", "P&L booked ₹6,250 per lot, Big Day !"],
      }),
    ).rejects.toThrow(
      /Message: Invalid parameter[\s\S]*Details: Parameter 2 \("product_name"\) contains invalid value[\s\S]*Subcode: 2494073[\s\S]*Trace: A1BC\.\.\./,
    );

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[meta-api] Meta API error response"),
      expect.objectContaining({
        message: "Invalid parameter",
        type: "OAuthException",
        code: 100,
        error_subcode: 2494073,
        error_data: { details: 'Parameter 2 ("product_name") contains invalid value' },
        fbtrace_id: "A1BC...",
      }),
    );
    consoleSpy.mockRestore();
  });

  it("falls back to the status-based message when the body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 502 })),
    );

    await expect(
      sendTemplateMessage({
        phoneNumberId: "test-phone",
        accessToken: "test-token",
        to: "1234567890",
        templateName: "cancellation_confirmation_edu",
        language: "en_US",
        params: ["Target 2 Hit"],
      }),
    ).rejects.toThrow(/Message: Meta API error: 502/);
  });
});

describe("sendTemplateMessage — parameter payload shape", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  type TestParams = string[] | { key: string; value: string }[];

  async function capturePayload(params: TestParams) {
    let captured: unknown = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({ messages: [{ id: "wamid.T" }] }),
          { status: 200 },
        );
      }),
    );
    await sendTemplateMessage({
      phoneNumberId: "test-phone",
      accessToken: "test-token",
      to: "1234567890",
      templateName: "order_confirmation",
      language: "en_US",
      params: params as never,
    });
    return captured;
  }

  it("emits bare text parameters for positional {{1}}, {{2}}", async () => {
    const body = (await capturePayload(["Target 2 Hit", "OTP 1234"])) as {
      template: { components: { parameters: unknown[] }[] };
    };
    expect(body.template.components[0].parameters).toEqual([
      { type: "text", text: "Target 2 Hit" },
      { type: "text", text: "OTP 1234" },
    ]);
  });

  it("emits parameter_name for named {{customer_name}}, {{product_name}}", async () => {
    const body = (await capturePayload([
      { key: "customer_name", value: "Target 2 Hit" },
      { key: "product_name", value: "P&L booked ₹6,250 per lot, Big Day !" },
    ])) as { template: { components: { parameters: unknown[] }[] } };
    expect(body.template.components[0].parameters).toEqual([
      { type: "text", parameter_name: "customer_name", text: "Target 2 Hit" },
      {
        type: "text",
        parameter_name: "product_name",
        text: "P&L booked ₹6,250 per lot, Big Day !",
      },
    ]);
  });

  it("emits per-key objects for a mixed body", async () => {
    const body = (await capturePayload([
      { key: "1", value: "Target 2 Hit" },
      { key: "product_name", value: "Acme Corp" },
    ])) as { template: { components: { parameters: unknown[] }[] } };
    expect(body.template.components[0].parameters).toEqual([
      { type: "text", text: "Target 2 Hit" },
      { type: "text", parameter_name: "product_name", text: "Acme Corp" },
    ]);
  });

  it("omits components entirely when there are no params", async () => {
    const body = (await capturePayload([])) as { template: Record<string, unknown> };
    expect(body.template.components).toBeUndefined();
  });
});

describe("sendTemplateMessage — template-aware header handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const BASE = {
    phoneNumberId: "test-phone",
    accessToken: "test-token",
    to: "1234567890",
    templateName: "order_updates_1",
    language: "en_US",
  } as const;

  async function captureHeaderPayload(args: {
    templateHeaderType?: "text" | "image" | "video" | "document" | null;
    headerImageUrl?: string;
    params?: { key: string; value: string }[];
  }) {
    const captured: { body: unknown } = { body: null };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        captured.body = JSON.parse(String(init.body));
        return new Response(
          JSON.stringify({ messages: [{ id: "wamid.H" }] }),
          { status: 200 },
        );
      }),
    );
    await sendTemplateMessage({ ...BASE, ...args });
    return captured.body as {
      template: { components: { type: string; parameters?: unknown[] }[] };
    };
  }

  it("emits an IMAGE header with the selected image link when the template header is IMAGE", async () => {
    const body = await captureHeaderPayload({
      templateHeaderType: "image",
      headerImageUrl: "https://cdn.example.com/header.png",
      params: [{ key: "order_details", value: "Manish Bhagat" }],
    });

    expect(body.template.components[0]).toEqual({
      type: "header",
      parameters: [
        {
          type: "image",
          image: { link: "https://cdn.example.com/header.png" },
        },
      ],
    });
    expect(body.template.components[1]).toEqual({
      type: "body",
      parameters: [
        {
          type: "text",
          parameter_name: "order_details",
          text: "Manish Bhagat",
        },
      ],
    });
  });

  it.each([
    ["undefined", undefined],
    ["empty string", ""],
    ["whitespace", "   "],
  ])(
    "rejects an IMAGE-header template with %s headerImageUrl before calling Meta",
    async (_label, headerImageUrl) => {
      const fetchMock = vi.fn(neverFetch);
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        sendTemplateMessage({
          ...BASE,
          templateHeaderType: "image",
          headerImageUrl,
          params: [{ key: "order_details", value: "Manish Bhagat" }],
        }),
      ).rejects.toThrow(/requires a header image/);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("sends a template with no header and no image without a header component", async () => {
    const body = await captureHeaderPayload({
      params: [{ key: "customer_name", value: "Manish Bhagat" }],
    });

    expect(body.template.components).toEqual([
      {
        type: "body",
        parameters: [
          {
            type: "text",
            parameter_name: "customer_name",
            text: "Manish Bhagat",
          },
        ],
      },
    ]);
  });

  it("does not invent an IMAGE header when an image is selected for a template with no header", async () => {
    const body = await captureHeaderPayload({
      headerImageUrl: "https://cdn.example.com/header.png",
      params: [{ key: "customer_name", value: "Manish Bhagat" }],
    });

    expect(
      body.template.components.filter((c) => c.type === "header"),
    ).toHaveLength(0);
    expect(body.template.components).toEqual([
      {
        type: "body",
        parameters: [
          {
            type: "text",
            parameter_name: "customer_name",
            text: "Manish Bhagat",
          },
        ],
      },
    ]);
  });

  it("does not treat a TEXT-header template as an IMAGE template", async () => {
    const body = await captureHeaderPayload({
      templateHeaderType: "text",
      headerImageUrl: "https://cdn.example.com/header.png",
      params: [{ key: "customer_name", value: "Manish Bhagat" }],
    });

    expect(
      body.template.components.filter((c) => c.type === "header"),
    ).toHaveLength(0);
    let hasImageParam = false;
    for (const component of body.template.components) {
      const parameters = component.parameters ?? [];
      for (const param of parameters) {
        if ((param as { type?: string }).type === "image") hasImageParam = true;
      }
    }
    expect(hasImageParam).toBe(false);
  });

  it("preserves parameter_name for named body variables alongside an IMAGE header", async () => {
    const body = await captureHeaderPayload({
      templateHeaderType: "image",
      headerImageUrl: "https://cdn.example.com/header.png",
      params: [{ key: "order_details", value: "Manish Bhagat" }],
    });

    expect(body.template.components[1]).toEqual({
      type: "body",
      parameters: [
        {
          type: "text",
          parameter_name: "order_details",
          text: "Manish Bhagat",
        },
      ],
    });
  });
});
