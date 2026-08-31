/**
 * Pure, server-safe variable resolution for broadcast sends.
 *
 * The composer hook and the scheduled-send cron both need to turn a
 * broadcast's stored `template_variables` mapping into per-recipient
 * Meta body params. Keeping the resolution here (no React, no client
 * supabase) lets the Node-side cron import it directly while the hook
 * re-exports it for page-level code.
 */
import type { Contact } from '@/types'
import {
  orderVariableKeys,
  type TemplateVariableValue,
} from '@/lib/whatsapp/template-variables'

export type VariableMapping =
  | { type: 'static'; value: string }
  | { type: 'field'; value: string }
  | { type: 'custom_field'; value: string };

/** contactId → (customFieldId → value). */
export type CustomValueIndex = Map<string, Map<string, string>>;

/**
 * Per-contact resolution of template placeholders. Static and
 * built-in-field mappings resolve synchronously; custom fields read
 * from a pre-built index to avoid N+1 queries during the send loop.
 *
 * The returned array is ordered — values[i] fills the i-th
 * {{placeholder}} in the template body — so `body` orders the keys
 * (body order for both named and numeric placeholders, not
 * alphabetical). Each value carries its placeholder `key`, which the
 * Meta parameter builder uses to emit `parameter_name` for named
 * placeholders. Without `body` the keys fall back to numeric-aware
 * order to preserve legacy behaviour.
 */
export function resolveVariables(
  variables: Record<string, VariableMapping>,
  contact: Contact,
  customValues?: Map<string, string>,
  body?: string,
): TemplateVariableValue[] {
  const keys = orderVariableKeys(variables, body);

  return keys.map((key) => {
    const v = variables[key];

    if (v.type === 'static') return { key, value: v.value };

    if (v.type === 'field') {
      const fieldMap: Record<string, string | undefined> = {
        name: contact.name,
        phone: contact.phone,
        email: contact.email,
        company: contact.company,
      };
      return { key, value: fieldMap[v.value] ?? '' };
    }

    // custom_field
    return { key, value: customValues?.get(v.value) ?? '' };
  });
}

/** Fold contact_custom_values rows into the contact → field → value index. */
export function buildCustomValueIndex(
  rows: { contact_id: string; custom_field_id: string; value: string | null }[],
): CustomValueIndex {
  const index: CustomValueIndex = new Map();
  for (const row of rows) {
    const bucket = index.get(row.contact_id) ?? new Map<string, string>();
    bucket.set(row.custom_field_id, row.value ?? '');
    index.set(row.contact_id, bucket);
  }
  return index;
}