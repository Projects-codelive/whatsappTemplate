import { describe, expect, it } from "vitest";
import type { Contact } from "../../types";
import {
  buildBodyParameters,
  extractPlaceholderKeys,
  extractPlaceholders,
  formatPlaceholderLabel,
  isNumericPlaceholderKey,
  normalizeTemplateParameters,
  orderVariableKeys,
  placeholderFormat,
  placeholderKey,
  placeholderToken,
  renderTemplateBody,
  usesNamedPlaceholders,
} from "./template-variables";
import { resolveVariables } from "../../hooks/use-broadcast-sending";

const contact: Contact = {
  id: "c1",
  user_id: "u1",
  phone: "+1234567890",
  name: "Target 2 Hit",
  email: "t@example.com",
  company: "Acme Corp",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

describe("extractPlaceholderKeys", () => {
  it("detects positional placeholders", () => {
    expect(extractPlaceholderKeys("Hi {{1}} your OTP is {{2}}")).toEqual([
      "1",
      "2",
    ]);
  });

  it("detects named placeholders", () => {
    expect(
      extractPlaceholderKeys(
        "Hi {{customer_name}}, your *{{product_name}}* is ready.",
      ),
    ).toEqual(["customer_name", "product_name"]);
  });

  it("detects a mixed body in appearance order", () => {
    expect(
      extractPlaceholderKeys("Hi {{1}}, your {{product_name}} is ready"),
    ).toEqual(["1", "product_name"]);
  });

  it("de-duplicates repeated placeholders keeping first occurrence", () => {
    expect(
      extractPlaceholderKeys(
        "{{customer_name}}, welcome {{customer_name}}!",
      ),
    ).toEqual(["customer_name"]);
  });

  it("extractPlaceholders wraps tokens back", () => {
    expect(extractPlaceholders("Hi {{customer_name}}")).toEqual([
      "{{customer_name}}",
    ]);
  });

  it("placeholderKey / placeholderToken round-trip", () => {
    expect(placeholderKey("{{product_name}}")).toBe("product_name");
    expect(placeholderToken("product_name")).toBe("{{product_name}}");
  });
});

describe("orderVariableKeys", () => {
  it("orders by body appearance, not alphabetically", () => {
    const variables = { zebra: "z", apple: "a" };
    expect(
      orderVariableKeys(variables, "Hi {{zebra}}, then {{apple}}"),
    ).toEqual(["zebra", "apple"]);
  });

  it("skips keys absent from the body and appends leftovers numeric-aware", () => {
    expect(
      orderVariableKeys({ "1": "a", "2": "b" }, "Hi {{1}}"),
    ).toEqual(["1", "2"]);
  });

  it("falls back to numeric-aware ordering without a body", () => {
    expect(
      orderVariableKeys({ "10": "j", "1": "a", "2": "b" }),
    ).toEqual(["1", "2", "10"]);
  });
});

describe("formatPlaceholderLabel", () => {
  it("humanizes named keys", () => {
    expect(formatPlaceholderLabel("customer_name")).toBe("Customer Name");
    expect(formatPlaceholderLabel("first_name")).toBe("First Name");
    expect(formatPlaceholderLabel("product_name")).toBe("Product Name");
  });

  it("keeps numeric keys in their literal token form", () => {
    expect(formatPlaceholderLabel("1")).toBe("{{1}}");
    expect(isNumericPlaceholderKey("2")).toBe(true);
    expect(isNumericPlaceholderKey("customer_name")).toBe(false);
  });
});

describe("renderTemplateBody", () => {
  it("substitutes params positionally in body order", () => {
    expect(
      renderTemplateBody("Hi {{customer_name}}, your {{product_name}}", [
        "Target 2 Hit",
        "P&L booked ₹6,250 per lot, Big Day !",
      ]),
    ).toBe("Hi Target 2 Hit, your P&L booked ₹6,250 per lot, Big Day !");
  });

  it("leaves tokens in place when params are missing", () => {
    expect(renderTemplateBody("Hi {{customer_name}}", [])).toBe(
      "Hi {{customer_name}}",
    );
  });

  it("fills every occurrence of a repeated placeholder", () => {
    expect(renderTemplateBody("{{customer_name}} {{customer_name}}", ["X"])).toBe(
      "X X",
    );
  });
});

describe("resolveVariables — validation cases", () => {
  it("Case 1: positional only — Hi {{1}}", () => {
    expect(
      resolveVariables(
        { "1": { type: "static", value: "OTP 1234" } },
        contact,
        undefined,
        "Hi {{1}}",
      ),
    ).toEqual([{ key: "1", value: "OTP 1234" }]);
  });

  it("Case 2: named only — Hi {{customer_name}}", () => {
    expect(
      resolveVariables(
        { customer_name: { type: "field", value: "name" } },
        contact,
        undefined,
        "Hi {{customer_name}}",
      ),
    ).toEqual([{ key: "customer_name", value: "Target 2 Hit" }]);
  });

  it("Case 3: named pair — Hi {{customer_name}}, your {{product_name}}", () => {
    expect(
      resolveVariables(
        {
          customer_name: { type: "field", value: "name" },
          product_name: {
            type: "static",
            value: "P&L booked ₹6,250 per lot, Big Day !",
          },
        },
        contact,
        undefined,
        "Hi {{customer_name}}, your {{product_name}}",
      ),
    ).toEqual([
      { key: "customer_name", value: "Target 2 Hit" },
      {
        key: "product_name",
        value: "P&L booked ₹6,250 per lot, Big Day !",
      },
    ]);
  });

  it("Case 4: mixed — Hi {{1}}, your {{product_name}}", () => {
    expect(
      resolveVariables(
        {
          "1": { type: "field", value: "name" },
          product_name: { type: "field", value: "company" },
        },
        contact,
        undefined,
        "Hi {{1}}, your {{product_name}}",
      ),
    ).toEqual([
      { key: "1", value: "Target 2 Hit" },
      { key: "product_name", value: "Acme Corp" },
    ]);
  });

  it("legacy: no body falls back to numeric-aware ordering", () => {
    expect(
      resolveVariables(
        {
          "2": { type: "static", value: "otp" },
          "1": { type: "static", value: "name" },
        },
        contact,
      ),
    ).toEqual([
      { key: "1", value: "name" },
      { key: "2", value: "otp" },
    ]);
  });
});

describe("placeholderFormat / usesNamedPlaceholders", () => {
  it("detects positional format from the body", () => {
    expect(placeholderFormat("Hi {{1}} your OTP is {{2}}")).toBe("positional");
    expect(usesNamedPlaceholders(extractPlaceholderKeys("Hi {{1}}"))).toBe(
      false,
    );
  });

  it("detects named format from the body", () => {
    expect(
      placeholderFormat("Hi {{customer_name}}, your {{product_name}}"),
    ).toBe("named");
    expect(
      usesNamedPlaceholders(
        extractPlaceholderKeys("Hi {{customer_name}}"),
      ),
    ).toBe(true);
  });

  it("reports none for bodies without placeholders", () => {
    expect(placeholderFormat("Plain text")).toBe("none");
    expect(placeholderFormat(undefined)).toBe("none");
  });
});

describe("buildBodyParameters", () => {
  it("emits bare text parameters for positional {{1}}, {{2}}", () => {
    expect(
      buildBodyParameters([
        { key: "1", value: "Target 2 Hit" },
        { key: "2", value: "OTP 1234" },
      ]),
    ).toEqual([
      { type: "text", text: "Target 2 Hit" },
      { type: "text", text: "OTP 1234" },
    ]);
  });

  it("emits parameter_name for named {{customer_name}}, {{product_name}}", () => {
    expect(
      buildBodyParameters([
        { key: "customer_name", value: "Target 2 Hit" },
        { key: "product_name", value: "P&L booked ₹6,250 per lot, Big Day !" },
      ]),
    ).toEqual([
      { type: "text", parameter_name: "customer_name", text: "Target 2 Hit" },
      {
        type: "text",
        parameter_name: "product_name",
        text: "P&L booked ₹6,250 per lot, Big Day !",
      },
    ]);
  });

  it("emits per-key objects for a mixed body", () => {
    expect(
      buildBodyParameters([
        { key: "1", value: "Target 2 Hit" },
        { key: "product_name", value: "Acme Corp" },
      ]),
    ).toEqual([
      { type: "text", text: "Target 2 Hit" },
      { type: "text", parameter_name: "product_name", text: "Acme Corp" },
    ]);
  });

  it("returns an empty array for no values", () => {
    expect(buildBodyParameters([])).toEqual([]);
  });
});

describe("normalizeTemplateParameters", () => {
  it("passes structured values through unchanged", () => {
    const input = [{ key: "customer_name", value: "X" }];
    expect(normalizeTemplateParameters(input)).toBe(input);
  });

  it("converts legacy string[] into numeric-keyed values", () => {
    expect(normalizeTemplateParameters(["Target 2 Hit", "OTP 1234"])).toEqual([
      { key: "1", value: "Target 2 Hit" },
      { key: "2", value: "OTP 1234" },
    ]);
  });

  it("returns undefined for empty or missing params", () => {
    expect(normalizeTemplateParameters(undefined)).toBeUndefined();
    expect(normalizeTemplateParameters([])).toBeUndefined();
  });
});
