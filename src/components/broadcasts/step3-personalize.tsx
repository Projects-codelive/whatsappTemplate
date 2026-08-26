'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Contact, CustomField, MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ArrowLeft, ArrowRight, Eye, Loader2, Upload, X, Image } from 'lucide-react';
import {
  extractPlaceholders,
  formatPlaceholderLabel,
  isNumericPlaceholderKey,
  placeholderKey,
} from '@/lib/whatsapp/template-variables';
import { uploadImageToStorage } from '@/lib/whatsapp/upload-media';

type VariableType = 'static' | 'field' | 'custom_field';

interface VariableMapping {
  type: VariableType;
  value: string;
}

interface Step3Props {
  template: MessageTemplate;
  variables: Record<string, VariableMapping>;
  onUpdate: (variables: Record<string, VariableMapping>) => void;
  headerImageUrl: string;
  onHeaderImageChange: (url: string) => void;
  onNext: () => void;
  onBack: () => void;
}

const contactFields = [
  { value: 'name', label: 'Contact Name' },
  { value: 'phone', label: 'Phone Number' },
  { value: 'email', label: 'Email Address' },
  { value: 'company', label: 'Company' },
];

const SAMPLE_CONTACT: Contact = {
  id: 'sample',
  user_id: '',
  name: 'John Doe',
  phone: '+1234567890',
  email: 'john@example.com',
  company: 'Acme Corp',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

export function Step3Personalize({
  template,
  variables,
  onUpdate,
  headerImageUrl,
  onHeaderImageChange,
  onNext,
  onBack,
}: Step3Props) {
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loadingFields, setLoadingFields] = useState(true);
  const [firstContact, setFirstContact] = useState<Contact | null>(null);
  const [firstContactCustomValues, setFirstContactCustomValues] = useState<
    Map<string, string>
  >(new Map());
  const [loadingPreview, setLoadingPreview] = useState(true);
  const [uploadingHeader, setUploadingHeader] = useState(false);
  const [headerUploadError, setHeaderUploadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const [fieldsRes, contactRes] = await Promise.all([
        supabase.from('custom_fields').select('*').order('field_name'),
        supabase
          .from('contacts')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);
      if (cancelled) return;

      setCustomFields(fieldsRes.data ?? []);
      setLoadingFields(false);

      const contact = contactRes.data ?? null;
      setFirstContact(contact);

      if (contact) {
        const { data: customVals } = await supabase
          .from('contact_custom_values')
          .select('custom_field_id, value')
          .eq('contact_id', contact.id);
        if (!cancelled) {
          const map = new Map<string, string>();
          for (const row of customVals ?? []) {
            map.set(row.custom_field_id, row.value ?? '');
          }
          setFirstContactCustomValues(map);
        }
      }
      setLoadingPreview(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const placeholders = useMemo(() => {
    return extractPlaceholders(template.body_text);
  }, [template.body_text]);

  const unmappedKeys = useMemo(() => {
    const missing: string[] = [];
    for (const placeholder of placeholders) {
      const key = placeholderKey(placeholder);
      const mapping = variables[key];
      if (!mapping || !mapping.value?.trim()) {
        missing.push(placeholder);
      }
    }
    return missing;
  }, [placeholders, variables]);

  function updateVariable(key: string, patch: Partial<VariableMapping>) {
    const current = variables[key] ?? {
      type: 'static' as VariableType,
      value: '',
    };
    onUpdate({
      ...variables,
      [key]: { ...current, ...patch },
    });
  }

  async function handleHeaderImageUpload(file: File) {
    setUploadingHeader(true);
    setHeaderUploadError(null);
    try {
      const url = await uploadImageToStorage(file);
      onHeaderImageChange(url);
    } catch (err) {
      setHeaderUploadError(
        err instanceof Error ? err.message : 'Image upload failed',
      );
    } finally {
      setUploadingHeader(false);
    }
  }

  const previewText = useMemo(() => {
    const contact = firstContact ?? SAMPLE_CONTACT;
    const customValues = firstContact
      ? firstContactCustomValues
      : new Map<string, string>();

    let text = template.body_text;
    for (const placeholder of placeholders) {
      const key = placeholderKey(placeholder);
      const mapping = variables[key];
      let replacement = placeholder;

      if (mapping) {
        if (mapping.type === 'static' && mapping.value) {
          replacement = mapping.value;
        } else if (mapping.type === 'field' && mapping.value) {
          const fieldMap: Record<string, string | undefined> = {
            name: contact.name,
            phone: contact.phone,
            email: contact.email,
            company: contact.company,
          };
          replacement = fieldMap[mapping.value] ?? placeholder;
        } else if (mapping.type === 'custom_field' && mapping.value) {
          replacement = customValues.get(mapping.value) || placeholder;
        }
      }
      text = text.replaceAll(placeholder, replacement);
    }
    return text;
  }, [
    template.body_text,
    variables,
    placeholders,
    firstContact,
    firstContactCustomValues,
  ]);

  const previewLabel = firstContact
    ? firstContact.name || firstContact.phone
    : 'sample data';

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white">
          Personalize Message
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          Map template variables to contact fields, custom fields, or static
          values. Optionally add a header image.
        </p>
      </div>

      {/* Header Image — optional, above placeholders */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
        <div className="mb-3 flex items-center gap-2">
          <Image className="h-4 w-4 text-slate-400" />
          <p className="text-sm font-medium text-white">Header Image</p>
          <span className="text-xs text-slate-500">(optional)</span>
        </div>

        <div className="space-y-2">
          <label
            className={`flex cursor-pointer items-center gap-2 rounded-md border border-slate-700 bg-slate-800 px-3 py-2 text-xs text-slate-300 transition-colors hover:bg-slate-700 ${uploadingHeader ? 'pointer-events-none opacity-60' : ''}`}
          >
            {uploadingHeader ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            {uploadingHeader ? 'Uploading...' : 'Upload Image (JPEG / PNG)'}
            <input
              type="file"
              accept="image/jpeg,image/png"
              className="hidden"
              disabled={uploadingHeader}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleHeaderImageUpload(file);
              }}
            />
          </label>

          <Input
            value={headerImageUrl}
            onChange={(e) => {
              onHeaderImageChange(e.target.value);
              setHeaderUploadError(null);
            }}
            placeholder="Or paste a public image URL..."
            className="border-slate-700 bg-slate-800 text-white placeholder:text-slate-500"
          />

          {headerUploadError && (
            <p className="text-xs text-red-400">{headerUploadError}</p>
          )}

          {headerImageUrl && (
            <div className="relative inline-block">
              <img
                src={headerImageUrl}
                alt="Header preview"
                className="h-24 w-auto rounded-md border border-slate-700 object-cover"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
              <button
                type="button"
                onClick={() => {
                  onHeaderImageChange('');
                  setHeaderUploadError(null);
                }}
                className="absolute -right-1.5 -top-1.5 rounded-full bg-slate-700 p-0.5 text-slate-300 hover:bg-slate-600"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Body placeholder mappings */}
      {placeholders.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6 text-center">
          <p className="text-sm text-slate-400">
            This template has no variables to personalize.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {placeholders.map((placeholder) => {
            const key = placeholderKey(placeholder);
            const mapping = variables[key] ?? { type: 'static', value: '' };

            return (
              <div
                key={placeholder}
                className="rounded-xl border border-slate-800 bg-slate-900/50 p-4"
              >
                <div className="mb-3 flex items-center gap-2">
                  <span className="bg-primary/10 text-primary inline-flex items-center rounded-md px-2 py-0.5 font-mono text-xs font-medium">
                    {formatPlaceholderLabel(key)}
                  </span>
                  {!isNumericPlaceholderKey(key) && (
                    <span className="text-xs text-slate-500">
                      {placeholder}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-slate-400">
                      Mapping Type
                    </label>
                    <Select
                      value={mapping.type}
                      onValueChange={(val) =>
                        updateVariable(key, {
                          type: val as VariableType,
                          value: '',
                        })
                      }
                    >
                      <SelectTrigger className="w-full border-slate-700 bg-slate-800 text-white">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="border-slate-700 bg-slate-800">
                        <SelectItem value="static">Static Value</SelectItem>
                        <SelectItem value="field">Contact Field</SelectItem>
                        <SelectItem value="custom_field">
                          Custom Field
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div>
                    <label className="mb-1.5 block text-xs font-medium text-slate-400">
                      {mapping.type === 'static' ? 'Value' : 'Field'}
                    </label>

                    {mapping.type === 'static' ? (
                      <Input
                        value={mapping.value}
                        onChange={(e) =>
                          updateVariable(key, { value: e.target.value })
                        }
                        placeholder="Enter value..."
                        className="border-slate-700 bg-slate-800 text-white placeholder:text-slate-500"
                      />
                    ) : mapping.type === 'field' ? (
                      <Select
                        value={mapping.value || undefined}
                        onValueChange={(val) =>
                          updateVariable(key, { value: val || '' })
                        }
                      >
                        <SelectTrigger className="w-full border-slate-700 bg-slate-800 text-white">
                          <SelectValue placeholder="Select field..." />
                        </SelectTrigger>
                        <SelectContent className="border-slate-700 bg-slate-800">
                          {contactFields.map((field) => (
                            <SelectItem key={field.value} value={field.value}>
                              {field.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Select
                        value={mapping.value || undefined}
                        onValueChange={(val) =>
                          updateVariable(key, { value: val || '' })
                        }
                      >
                        <SelectTrigger className="w-full border-slate-700 bg-slate-800 text-white">
                          <SelectValue
                            placeholder={
                              loadingFields
                                ? 'Loading…'
                                : customFields.length === 0
                                  ? 'No custom fields'
                                  : 'Select custom field…'
                            }
                          />
                        </SelectTrigger>
                        <SelectContent className="border-slate-700 bg-slate-800">
                          {customFields.map((f) => (
                            <SelectItem key={f.id} value={f.id}>
                              {f.field_name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Live Preview */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
        <div className="mb-3 flex items-center gap-2">
          <Eye className="text-primary h-4 w-4" />
          <p className="text-sm font-medium text-white">Live Preview</p>
          <span className="text-xs text-slate-500">({previewLabel})</span>
          {loadingPreview && (
            <Loader2 className="text-primary h-3.5 w-3.5 animate-spin" />
          )}
        </div>
        <div className="rounded-lg bg-[#0e1a12] p-3">
          <div className="bg-primary/30 ml-auto max-w-[85%] rounded-lg px-3 py-2 shadow-sm">
            {headerImageUrl && (
              <img
                src={headerImageUrl}
                alt="Template header"
                className="mb-2 w-full rounded-md object-cover"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            )}
            <p className="text-primary text-sm whitespace-pre-wrap">
              {previewText}
            </p>
          </div>
        </div>
      </div>

      {unmappedKeys.length > 0 && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          Map every placeholder before continuing — still missing{' '}
          <span className="font-mono font-semibold">
            {unmappedKeys.join(', ')}
          </span>
          . Otherwise those placeholders will ship to Meta as empty strings.
        </div>
      )}

      <div className="flex items-center justify-between border-t border-slate-800 pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          className="border-slate-700 text-slate-300"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>
        <Button
          onClick={onNext}
          disabled={unmappedKeys.length > 0}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Next
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
