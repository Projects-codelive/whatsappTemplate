'use client';

import { useState, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Upload, FileText, Loader2, CheckCircle, XCircle } from 'lucide-react';

interface ImportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => void;
}

interface ParsedRow {
  phone: string;
  name?: string;
  email?: string;
  company?: string;
  tags?: string[];
}

function parseCSV(text: string): ParsedRow[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const headerLine = lines[0];
  const headers = headerLine.split(',').map((h) => h.trim().toLowerCase().replace(/["']/g, ''));

  const phoneIdx = headers.indexOf('phone');
  if (phoneIdx === -1) return [];

  const nameIdx = headers.indexOf('name');
  const emailIdx = headers.indexOf('email');
  const companyIdx = headers.indexOf('company');
  const tagsIdx = headers.indexOf('tags');

  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values: string[] = [];
    let current = '';
    let inQuotes = false;
    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    values.push(current.trim());

    const phone = values[phoneIdx]?.replace(/["']/g, '').trim();
    if (!phone) continue;

    const rawTags = tagsIdx >= 0 ? values[tagsIdx]?.replace(/["']/g, '').trim() : '';
    const tags = rawTags
      ? rawTags.split(/[;,]/).map((t) => t.trim()).filter(Boolean)
      : undefined;

    rows.push({
      phone,
      name: nameIdx >= 0 ? values[nameIdx]?.replace(/["']/g, '').trim() || undefined : undefined,
      email: emailIdx >= 0 ? values[emailIdx]?.replace(/["']/g, '').trim() || undefined : undefined,
      company: companyIdx >= 0 ? values[companyIdx]?.replace(/["']/g, '').trim() || undefined : undefined,
      tags,
    });
  }

  return rows;
}

export function ImportModal({ open, onOpenChange, onImported }: ImportModalProps) {
  const supabase = createClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [parsedRows, setParsedRows] = useState<ParsedRow[]>([]);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState('');
  const [result, setResult] = useState<{ imported: number; failed: number } | null>(null);

  function reset() {
    setFile(null);
    setParsedRows([]);
    setResult(null);
    setProgress(0);
    setProgressLabel('');
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleOpenChange(isOpen: boolean) {
    if (!isOpen) reset();
    onOpenChange(isOpen);
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0];
    if (!selected) return;
    setFile(selected);
    setResult(null);
    const text = await selected.text();
    const rows = parseCSV(text);
    if (rows.length === 0) {
      toast.error('No valid rows found. Ensure CSV has a "phone" column header.');
      setParsedRows([]);
      return;
    }
    setParsedRows(rows);
  }

  async function handleImport() {
    if (parsedRows.length === 0) return;
    setImporting(true);
    setProgress(0);
    setProgressLabel('Preparing tags...');

    try {
      const { data: { session } } = await supabase.auth.getSession();
      const user = session?.user;
      if (!user) throw new Error('Not authenticated');

      // ── STEP 1: Collect ALL unique tag names from entire CSV (1 pass, no API calls) ──
      const allTagNames = Array.from(
        new Set(parsedRows.flatMap((r) => r.tags ?? []).filter(Boolean))
      );

      // tagNameToId will hold name → uuid for every tag we need
      const tagNameToId: Record<string, string> = {};

      if (allTagNames.length > 0) {
        // ── STEP 2: Fetch ALL existing tags in ONE single API call ──
        const { data: existingTags } = await supabase
          .from('tags')
          .select('id, name')
          .eq('user_id', user.id)
          .in('name', allTagNames);

        existingTags?.forEach((t) => { tagNameToId[t.name] = t.id; });

        // ── STEP 3: Create ONLY missing tags in ONE batch insert ──
        const missingNames = allTagNames.filter((n) => !tagNameToId[n]);
        if (missingNames.length > 0) {
          const { data: newTags } = await supabase
            .from('tags')
            .insert(missingNames.map((name) => ({ user_id: user.id, name, color: '#6366f1' })))
            .select('id, name');
          newTags?.forEach((t) => { tagNameToId[t.name] = t.id; });
        }
      }

      setProgress(5);
      setProgressLabel('Importing contacts...');

      // ── STEP 4: Insert contacts in chunks of 1000 ──
      let imported = 0;
      let failed = 0;
      const chunkSize = 1000;

      // We need to track which inserted contact ID maps to which CSV row
      // so we can build contact_tags later
      const insertedMap: { contactId: string; rowIndex: number }[] = [];

      for (let i = 0; i < parsedRows.length; i += chunkSize) {
        const chunk = parsedRows.slice(i, i + chunkSize);
        const rows = chunk.map((row) => ({
          user_id: user.id,
          phone: row.phone,
          name: row.name || null,
          email: row.email || null,
          company: row.company || null,
        }));

        const { data, error } = await supabase
          .from('contacts')
          .insert(rows)
          .select('id');

        if (error) {
          // Chunk failed — try row by row as fallback
          for (let j = 0; j < chunk.length; j++) {
            const { data: single, error: singleErr } = await supabase
              .from('contacts')
              .insert(rows[j])
              .select('id')
              .single();
            if (singleErr) {
              failed++;
            } else {
              imported++;
              insertedMap.push({ contactId: single.id, rowIndex: i + j });
            }
          }
        } else {
          imported += data?.length ?? 0;
          data?.forEach((d, j) => {
            insertedMap.push({ contactId: d.id, rowIndex: i + j });
          });
        }

        // Update progress: contacts = 5% to 80%
        setProgress(5 + Math.round(((i + chunkSize) / parsedRows.length) * 75));
        setProgressLabel(`Importing contacts... ${Math.min(i + chunkSize, parsedRows.length).toLocaleString()} / ${parsedRows.length.toLocaleString()}`);
      }

      // ── STEP 5: Build ALL contact_tags rows in memory (no API calls) ──
      setProgressLabel('Linking tags...');
      setProgress(80);

      const contactTagRows: { contact_id: string; tag_id: string }[] = [];
      for (const { contactId, rowIndex } of insertedMap) {
        const tagNames = parsedRows[rowIndex]?.tags ?? [];
        for (const tagName of tagNames) {
          const tagId = tagNameToId[tagName];
          if (tagId) contactTagRows.push({ contact_id: contactId, tag_id: tagId });
        }
      }

      // ── STEP 6: Insert ALL contact_tags in chunks of 2000 (few API calls) ──
      if (contactTagRows.length > 0) {
        const tagChunkSize = 2000;
        for (let i = 0; i < contactTagRows.length; i += tagChunkSize) {
          await supabase
            .from('contact_tags')
            .insert(contactTagRows.slice(i, i + tagChunkSize));
          setProgress(80 + Math.round(((i + tagChunkSize) / contactTagRows.length) * 20));
        }
      }

      setProgress(100);
      setProgressLabel('Done!');
      setResult({ imported, failed });

      if (imported > 0) {
        toast.success(`${imported.toLocaleString()} contact${imported !== 1 ? 's' : ''} imported`);
        onImported();
      }
      if (failed > 0) {
        toast.error(`${failed.toLocaleString()} contact${failed !== 1 ? 's' : ''} failed to import`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Import failed';
      toast.error(message);
    } finally {
      setImporting(false);
    }
  }

  const preview = parsedRows.slice(0, 3);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="bg-slate-900 border-slate-700 text-slate-200 sm:max-w-lg flex flex-col max-h-[90vh] overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="text-white">Import Contacts</DialogTitle>
          <DialogDescription className="text-slate-400">
            Upload a CSV file with a &quot;phone&quot; column (required). Optional columns:
            name, email, company, tags. Separate multiple tags with a comma or semicolon (e.g. VIP,Lead or VIP;Lead).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 overflow-y-auto flex-1 py-2 pr-1">

          {/* Upload area */}
          <div
            onClick={() => !importing && fileInputRef.current?.click()}
            className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 transition-colors ${
              importing
                ? 'border-slate-700 cursor-not-allowed opacity-50'
                : 'border-slate-700 cursor-pointer hover:border-primary/50'
            }`}
          >
            {file ? (
              <>
                <FileText className="size-8 text-primary" />
                <p className="text-sm text-slate-300">{file.name}</p>
                <p className="text-xs text-slate-500">
                  {parsedRows.length.toLocaleString()} row{parsedRows.length !== 1 ? 's' : ''} detected
                </p>
              </>
            ) : (
              <>
                <Upload className="size-8 text-slate-500" />
                <p className="text-sm text-slate-400">Click to upload CSV file</p>
                <p className="text-xs text-slate-500">CSV with &quot;phone&quot; column required</p>
              </>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={handleFileChange}
            className="hidden"
          />

          {/* Preview table */}
          {preview.length > 0 && !result && !importing && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                Preview (first 3 rows)
              </p>
              <div className="rounded-lg border border-slate-700 overflow-hidden">
                <div className="overflow-x-auto max-h-36 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 z-10">
                      <tr className="bg-slate-800">
                        <th className="px-3 py-1.5 text-left text-slate-400 font-medium">Phone</th>
                        <th className="px-3 py-1.5 text-left text-slate-400 font-medium">Name</th>
                        <th className="px-3 py-1.5 text-left text-slate-400 font-medium">Email</th>
                        <th className="px-3 py-1.5 text-left text-slate-400 font-medium">Company</th>
                        <th className="px-3 py-1.5 text-left text-slate-400 font-medium">Tags</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.map((row, i) => (
                        <tr key={i} className="border-t border-slate-700/50">
                          <td className="px-3 py-1.5 text-slate-300">{row.phone}</td>
                          <td className="px-3 py-1.5 text-slate-300">{row.name || '-'}</td>
                          <td className="px-3 py-1.5 text-slate-300">{row.email || '-'}</td>
                          <td className="px-3 py-1.5 text-slate-300">{row.company || '-'}</td>
                          <td className="px-3 py-1.5 text-slate-300">{row.tags?.join(', ') || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              {parsedRows.length > 3 && (
                <p className="text-xs text-slate-500">
                  ...and {(parsedRows.length - 3).toLocaleString()} more rows
                </p>
              )}
            </div>
          )}

          {/* Progress bar while importing */}
          {importing && (
            <div className="space-y-2">
              <div className="flex justify-between text-xs text-slate-400">
                <span>{progressLabel}</span>
                <span>{progress}%</span>
              </div>
              <div className="w-full h-2 bg-slate-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          )}

          {/* Results */}
          {result && (
            <div className="rounded-lg border border-slate-700 p-4 space-y-2">
              <p className="text-sm font-medium text-white">Import Complete</p>
              <div className="flex items-center gap-4">
                {result.imported > 0 && (
                  <div className="flex items-center gap-1.5 text-primary text-sm">
                    <CheckCircle className="size-4" />
                    {result.imported.toLocaleString()} imported
                  </div>
                )}
                {result.failed > 0 && (
                  <div className="flex items-center gap-1.5 text-red-400 text-sm">
                    <XCircle className="size-4" />
                    {result.failed.toLocaleString()} failed
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0 border-t border-slate-700 pt-3 bg-slate-900">
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={importing}
            className="border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-50"
          >
            {result ? 'Close' : 'Cancel'}
          </Button>
          {!result && (
            <Button
              type="button"
              disabled={parsedRows.length === 0 || importing}
              onClick={handleImport}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {importing && <Loader2 className="size-4 animate-spin" />}
              Import {parsedRows.length > 0 ? `${parsedRows.length.toLocaleString()} Contacts` : ''}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
