import { describe, expect, it } from "vitest";
import { persistRecipientUpdate } from "@/hooks/use-broadcast-sending";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeClient(failCount: { value: number }): any {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle() {
                  return Promise.resolve({ data: null, error: null });
                },
                single() {
                  return Promise.resolve({ data: null, error: null });
                },
                limit() {
                  return this;
                },
                order() {
                  return this;
                },
              };
            },
            in() {
              return {
                select() {
                  return {
                    eq() {
                      return Promise.resolve({ data: [], error: null });
                    },
                  };
                },
              };
            },
          };
        },
        insert() {
          return {
            then(onFulfilled: (v: unknown) => void) {
              return Promise.resolve(onFulfilled({ data: { id: "new" }, error: null }));
            },
          };
        },
        update() {
          if (failCount.value > 0) {
            failCount.value--;
            return {
              then(onFulfilled: (v: unknown) => void) {
                return Promise.resolve(
                  onFulfilled({ data: null, error: { message: "simulated db failure" } }),
                );
              },
              eq() {
                return this;
              },
            };
          }
          return {
            then(onFulfilled: (v: unknown) => void) {
              return Promise.resolve(onFulfilled({ data: null, error: null }));
            },
            eq() {
              return this;
            },
          };
        },
        delete() {
          return {
            eq() {
              return {
                then(onFulfilled: (v: unknown) => void) {
                  return Promise.resolve(onFulfilled({ data: null, error: null }));
                },
              };
            },
          };
        },
        eq() {
          return {
            then(onFulfilled: (v: unknown) => void) {
              return Promise.resolve(onFulfilled({ data: null, error: null }));
            },
          };
        },
        auth: {
          getSession() {
            return Promise.resolve({
              data: {
                session: {
                  user: { id: "user-1", email: "test@example.com" },
                },
              },
              error: null,
            });
          },
        },
      };
    },
  };
}

describe("persistRecipientUpdate — broadcast recipient DB persistence retry", () => {
  it("TEST 1 — persists whatsapp_message_id on first attempt", async () => {
    const client = makeClient({ value: 0 });
    const result = await persistRecipientUpdate(client, "recipient-1", {
      status: "sent",
      sent_at: "2024-01-01T00:00:00.000Z",
      whatsapp_message_id: "META_MESSAGE_ID_123",
      error_message: null,
    });
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(1);
  });

  it("TEST 2 — retries then succeeds on second attempt", async () => {
    const failCount = { value: 1 };
    const client = makeClient(failCount);
    const result = await persistRecipientUpdate(client, "recipient-1", {
      status: "sent",
      sent_at: "2024-01-01T00:00:00.000Z",
      whatsapp_message_id: "META_MESSAGE_ID_123",
      error_message: null,
    });
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("TEST 3 — marks failed after all retries exhausted", async () => {
    const failCount = { value: 10 };
    const client = makeClient(failCount);
    const result = await persistRecipientUpdate(client, "recipient-1", {
      status: "sent",
      sent_at: "2024-01-01T00:00:00.000Z",
      whatsapp_message_id: "META_MESSAGE_ID_123",
      error_message: null,
    });
    expect(result.success).toBe(false);
    expect(result.attempts).toBeLessThanOrEqual(3);
    expect(result.errorMessage).toContain("simulated db failure");
  });

  it("TEST 4 — bounded retry count", async () => {
    const failCount = { value: 10 };
    const client = makeClient(failCount);
    const result = await persistRecipientUpdate(client, "recipient-1", {
      status: "sent",
      sent_at: "2024-01-01T00:00:00.000Z",
      whatsapp_message_id: "META_MESSAGE_ID_123",
      error_message: null,
    });
    expect(result.attempts).toBeLessThanOrEqual(3);
  });
});


