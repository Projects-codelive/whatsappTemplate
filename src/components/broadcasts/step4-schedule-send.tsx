'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  ArrowLeft,
  Send,
  CalendarClock,
  Loader2,
  Users,
  Save,
  X,
} from 'lucide-react';

interface AudienceConfig {
  type: string;
  tagIds?: string[];
  csvContacts?: { phone: string; name?: string }[];
}

interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  template: MessageTemplate;
  audience: AudienceConfig;
  headerImageUrl?: string;
  /** 'now' sends immediately; 'scheduled' hands off to the cron. */
  sendingMode: 'now' | 'scheduled';
  onSendingModeChange: (mode: 'now' | 'scheduled') => void;
  /** ISO timestamp of the scheduled send, '' when unset. */
  scheduledAt: string;
  onScheduledAtChange: (iso: string) => void;
  onSend: () => void;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
}

/**
 * Validate a scheduled ISO timestamp for a send that has not yet
 * happened. Returns a human error string, or null when OK.
 */
export function validateScheduledAt(iso: string): string | null {
  if (!iso) return 'Pick a date and time to schedule the send.';
  const ms = new Date(iso).getTime();
  if (Number.isNaN(ms)) return 'That date and time is not valid.';
  if (ms <= Date.now()) return 'Scheduled time must be in the future.';
  return null;
}

/** ISO → local "YYYY-MM-DDTHH:mm" for <input type="datetime-local">. */
export function toLocalInputValue(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/** Local "YYYY-MM-DDTHH:mm" → ISO timestamp (locale-aware Date parse). */
export function fromLocalInputValue(value: string): string {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

export function Step4ScheduleSend({
  name,
  onNameChange,
  template,
  audience,
  headerImageUrl,
  sendingMode,
  onSendingModeChange,
  scheduledAt,
  onScheduledAtChange,
  onSend,
  onSaveDraft,
  onBack,
  isProcessing,
  progress,
}: Step4Props) {
  const [showConfirm, setShowConfirm] = useState(false);
  const [estimatedReach, setEstimatedReach] = useState<number>(0);
  const [loadingReach, setLoadingReach] = useState(true);

  const requiresHeaderImage = template.header_type === 'image';
  const headerImageMissing =
    requiresHeaderImage && !(headerImageUrl ?? '').trim();

  const scheduleError =
    sendingMode === 'scheduled' ? validateScheduledAt(scheduledAt) : null;

  useEffect(() => {
    async function calculateReach() {
      setLoadingReach(true);
      try {
        const supabase = createClient();

        if (audience.type === 'all') {
          const { count } = await supabase
            .from('contacts')
            .select('*', { count: 'exact', head: true });
          setEstimatedReach(count ?? 0);
        } else if (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) {
          const { data: contactTags } = await supabase
            .from('contact_tags')
            .select('contact_id')
            .in('tag_id', audience.tagIds);

          const uniqueIds = new Set((contactTags ?? []).map((ct) => ct.contact_id));
          setEstimatedReach(uniqueIds.size);
        } else if (audience.type === 'csv' && audience.csvContacts) {
          setEstimatedReach(audience.csvContacts.length);
        } else {
          setEstimatedReach(0);
        }
      } finally {
        setLoadingReach(false);
      }
    }

    calculateReach();
  }, [audience]);

  const audienceLabel =
    audience.type === 'all'
      ? 'All Contacts'
      : audience.type === 'tags'
        ? `Tags (${audience.tagIds?.length ?? 0} selected)`
        : audience.type === 'csv'
          ? 'CSV Upload'
          : 'Custom';

  const canSend =
    Boolean(name.trim()) &&
    !headerImageMissing &&
    !isProcessing &&
    (sendingMode !== 'scheduled' || scheduleError === null);

  const formattedScheduledAt =
    sendingMode === 'scheduled' && scheduledAt
      ? new Date(scheduledAt).toLocaleString()
      : null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-white">Review & Send</h2>
        <p className="mt-1 text-sm text-slate-400">
          Name your broadcast, review the details, and send now or schedule
          it for later.
        </p>
      </div>

      {/* Broadcast Name */}
      <div>
        <label className="mb-1.5 block text-sm font-medium text-white">Broadcast Name</label>
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="e.g. Summer Sale Announcement"
          className="border-slate-700 bg-slate-800 text-white placeholder:text-slate-500"
        />
      </div>

      {/* Send now vs Schedule */}
      <div>
        <label className="mb-1.5 block text-sm font-medium text-white">
          Delivery
        </label>
        <div className="inline-flex rounded-lg border border-slate-700 bg-slate-800 p-1">
          <button
            type="button"
            onClick={() => onSendingModeChange('now')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              sendingMode === 'now'
                ? 'bg-primary text-primary-foreground'
                : 'text-slate-300 hover:text-white'
            }`}
          >
            <Send className="h-3.5 w-3.5" />
            Send Now
          </button>
          <button
            type="button"
            onClick={() => onSendingModeChange('scheduled')}
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              sendingMode === 'scheduled'
                ? 'bg-primary text-primary-foreground'
                : 'text-slate-300 hover:text-white'
            }`}
          >
            <CalendarClock className="h-3.5 w-3.5" />
            Schedule
          </button>
        </div>

        {sendingMode === 'scheduled' && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Input
              type="datetime-local"
              value={toLocalInputValue(scheduledAt)}
              onChange={(e) => onScheduledAtChange(fromLocalInputValue(e.target.value))}
              className="w-auto border-slate-700 bg-slate-800 text-white [color-scheme:dark]"
            />
            {scheduledAt && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onScheduledAtChange('')}
                className="border-slate-700 text-slate-300 hover:bg-slate-800"
              >
                <X className="h-3.5 w-3.5" />
                Clear
              </Button>
            )}
            <span className="text-xs text-slate-400">
              The broadcast is sent by the server at this time — no browser
              needs to stay open. You can cancel it any time before then.
            </span>
          </div>
        )}
        {sendingMode === 'scheduled' && scheduleError && (
          <p className="mt-2 text-xs text-red-400">{scheduleError}</p>
        )}
      </div>

      {/* Summary Card */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 space-y-3">
        <p className="text-sm font-medium text-white">Summary</p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-slate-400">Template</p>
            <p className="text-white">{template.name}</p>
          </div>
          <div>
            <p className="text-xs text-slate-400">Audience</p>
            <p className="text-white">{audienceLabel}</p>
          </div>
          <div>
            <p className="text-xs text-slate-400">Estimated Reach</p>
            <div className="flex items-center gap-1.5">
              {loadingReach ? (
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
              ) : (
                <>
                  <Users className="h-3.5 w-3.5 text-primary" />
                  <p className="font-medium text-white">{estimatedReach.toLocaleString()}</p>
                </>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs text-slate-400">Delivery</p>
            <p className="text-white">
              {sendingMode === 'scheduled'
                ? formattedScheduledAt ?? 'Scheduled'
                : 'Immediately'}
            </p>
          </div>
        </div>
        {headerImageMissing && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
            This template has an image header. Add an image in the
            Personalize step before sending.
          </div>
        )}
      </div>

      {/* Processing overlay */}
      {isProcessing && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <p className="text-sm font-medium text-white">
                {sendingMode === 'scheduled'
                  ? 'Scheduling broadcast...'
                  : 'Sending broadcast...'}
              </p>
            </div>
            <span className="text-xs font-medium text-primary">{progress}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-slate-800">
            <div
              className="h-1.5 rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={isProcessing}
          className="border-slate-700 text-slate-300"
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </Button>

        <div className="flex items-center gap-2">
          {onSaveDraft && (
            <Button
              variant="outline"
              onClick={onSaveDraft}
              disabled={!name.trim() || isProcessing}
              className="border-slate-700 text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              Save as Draft
            </Button>
          )}

          <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
          <DialogTrigger
            render={
              <Button
                disabled={!canSend}
                className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              />
            }
          >
            {sendingMode === 'scheduled' ? (
              <CalendarClock className="h-4 w-4" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            {sendingMode === 'scheduled' ? 'Schedule Broadcast' : 'Send Broadcast'}
          </DialogTrigger>
          <DialogContent className="border-slate-700 bg-slate-900 sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-white">
                {sendingMode === 'scheduled'
                  ? 'Schedule Broadcast'
                  : 'Confirm Broadcast'}
              </DialogTitle>
              <DialogDescription className="text-slate-400">
                {sendingMode === 'scheduled' ? (
                  <>
                    Schedule this broadcast to{' '}
                    <span className="font-medium text-white">
                      {formattedScheduledAt}
                    </span>{' '}
                    for{' '}
                    <span className="font-medium text-white">
                      {estimatedReach.toLocaleString()}
                    </span>{' '}
                    contacts using the{' '}
                    <span className="font-medium text-white">
                      {template.name}
                    </span>{' '}
                    template. You can cancel it before it sends.
                  </>
                ) : (
                  <>
                    You are about to send this broadcast to{' '}
                    <span className="font-medium text-white">{estimatedReach.toLocaleString()}</span>{' '}
                    contacts using the{' '}
                    <span className="font-medium text-white">{template.name}</span> template.
                    This action cannot be undone.
                  </>
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowConfirm(false)}
                className="border-slate-700 text-slate-300"
              >
                Cancel
              </Button>
              <Button
                onClick={() => {
                  setShowConfirm(false);
                  onSend();
                }}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {sendingMode === 'scheduled' ? (
                  <CalendarClock className="h-4 w-4" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                {sendingMode === 'scheduled' ? 'Confirm & Schedule' : 'Confirm & Send'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        </div>
      </div>
    </div>
  );
}