/**
 * Named + positional WhatsApp template variable support.
 *
 * Meta-approved templates reference variables either positionally
 * ({{1}}, {{2}}, …) or by name ({{customer_name}}, {{product_name}}, …).
 * Every placeholder parser in the app funnels through this module so a
 * single ordering rule — first occurrence inside `body_text` — drives the
 * ordered `params` array the Cloud API requires. The array index maps to
 * the i-th placeholder in the body, so params MUST follow body order, not
 * alphabetical or insertion order.
 */

/** Matches the inner key of a {{placeholder}} token (named or numeric). */
export const TEMPLATE_PLACEHOLDER_RE = /\{\{([^{}]+)\}\}/g;

/** Wrap a key back into its {{token}} form. */
export function placeholderToken(key: string): string {
  return `{{${key}}}`;
}

/** Strip the braces off a {{token}} to get its key. */
export function placeholderKey(token: string): string {
  return token.slice(2, -2).trim();
}

/**
 * Keys of every placeholder in `body`, in order of first occurrence,
 * de-duplicated. Works for both {{1}} and {{customer_name}}.
 */
export function extractPlaceholderKeys(body: string): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(TEMPLATE_PLACEHOLDER_RE)) {
    const key = match[1].trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}

/** Full {{token}} strings in body order, e.g. ["{{1}}", "{{customer_name}}"]. */
export function extractPlaceholders(body: string): string[] {
  return extractPlaceholderKeys(body).map(placeholderToken);
}

export function isNumericPlaceholderKey(key: string): boolean {
  return /^\d+$/.test(key);
}

/**
 * Human-readable label for the personalization UI: {{customer_name}}
 * → "Customer Name"; {{1}} keeps its literal "{{1}}" form.
 */
export function formatPlaceholderLabel(key: string): string {
  if (isNumericPlaceholderKey(key)) return placeholderToken(key);
  return key
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Numeric-aware key comparator used for fallback ordering. Preserves
 * {{1}} < {{2}} < … < {{10}} instead of the lexicographic
 * "1", "10", "2", … trap.
 */
function compareKeys(a: string, b: string): number {
  const an = Number(a);
  const bn = Number(b);
  if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
  if (Number.isFinite(an)) return -1;
  if (Number.isFinite(bn)) return 1;
  return a.localeCompare(b);
}

/**
 * Order the keys of a variables map to match placeholder order inside
 * `body`. Keys present in the body follow body order (the requirement
 * for Meta's positional params). Any key not found in the body (stale
 * or legacy data) is appended in numeric-aware order so nothing is
 * silently dropped.
 */
export function orderVariableKeys(
  variables: Record<string, unknown>,
  body?: string,
): string[] {
  if (body) {
    const ordered: string[] = [];
    const seen = new Set<string>();
    for (const key of extractPlaceholderKeys(body)) {
      if (key in variables && !seen.has(key)) {
        ordered.push(key);
        seen.add(key);
      }
    }
    const rest = Object.keys(variables)
      .filter((key) => !seen.has(key))
      .sort(compareKeys);
    return [...ordered, ...rest];
  }
  return Object.keys(variables).sort(compareKeys);
}

/**
 * Render `body` with positional `params` substituted. params[i] fills
 * the i-th placeholder in body order. Unfilled or missing params leave
 * the original {{token}} in place so the UI can show what still needs a
 * value.
 */
export function renderTemplateBody(body: string, params: string[]): string {
  let text = body;
  extractPlaceholderKeys(body).forEach((key, index) => {
    const value = params[index];
    if (value && value.trim().length > 0) {
      text = text.replaceAll(placeholderToken(key), value);
    }
  });
  return text;
}

// ============================================================
// Meta send payloads — named vs positional parameters
// ============================================================
//
// Meta Cloud API templates are created with one of two parameter
// formats. The send payload differs per format:
//
//   positional ({{1}}, {{2}}):
//     { "type": "text", "text": "value" }
//   named ({{customer_name}}):
//     { "type": "text", "parameter_name": "customer_name", "text": "value" }
//
// Sending a named template without `parameter_name` returns Meta's
// "(#100) Invalid parameter — Parameter name is missing or empty".
// Everything below funnels through `buildBodyParameters` so the two
// formats can never drift apart.

/** One resolved placeholder: its key (no braces) plus its text value. */
export interface TemplateVariableValue {
  /** Placeholder key: "1", "2", … (positional) or "customer_name" (named). */
  key: string;
  /** Resolved text value. */
  value: string;
}

/**
 * A Meta body-component parameter object. Named placeholders require
 * `parameter_name`; positional must NOT include it.
 */
export type TemplateBodyParameter =
  | { type: "text"; text: string }
  | { type: "text"; parameter_name: string; text: string };

/** True when any key is a named (non-numeric) placeholder. */
export function usesNamedPlaceholders(keys: readonly string[]): boolean {
  return keys.some((key) => !isNumericPlaceholderKey(key));
}

/**
 * Detect a template body's parameter format from its placeholders —
 * never from the number of variables. `none` means the body has no
 * placeholders at all.
 */
export function placeholderFormat(
  body: string | undefined,
): "named" | "positional" | "none" {
  if (!body) return "none";
  const keys = extractPlaceholderKeys(body);
  if (keys.length === 0) return "none";
  return usesNamedPlaceholders(keys) ? "named" : "positional";
}

/**
 * Build the Meta `parameters` array for the template body component from
 * ordered (key, value) pairs. Named keys emit `parameter_name`; numeric
 * keys emit bare objects. Per-key emission keeps pure named, pure
 * positional, and (theoretically) mixed bodies correct — Meta's own rule
 * is per parameter, so this needs no template-level format switch.
 */
export function buildBodyParameters(
  values: readonly TemplateVariableValue[],
): TemplateBodyParameter[] {
  return values.map(({ key, value }) =>
    isNumericPlaceholderKey(key)
      ? { type: "text", text: value }
      : { type: "text", parameter_name: key, text: value },
  );
}

/**
 * Normalize a raw params input into ordered (key, value) pairs. Legacy
 * positional `string[]` values get synthetic numeric keys ("1", "2", …)
 * so they flow through the same builder and emit bare (positional) Meta
 * parameters exactly as before — preserving backward compatibility.
 */
export function normalizeTemplateParameters(
  params: TemplateVariableValue[] | string[] | undefined,
): TemplateVariableValue[] | undefined {
  if (!params || params.length === 0) return undefined;
  if (typeof params[0] === "string") {
    return (params as string[]).map((value, i) => ({
      key: String(i + 1),
      value,
    }));
  }
  return params as TemplateVariableValue[];
}
