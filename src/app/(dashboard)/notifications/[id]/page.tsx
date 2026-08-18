'use client';

import { useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Users,
  Send,
  AlertCircle,
  Filter,
  Download,
  ChevronDown,
  Trash2,
  Paperclip,
  Clock,
  CheckCircle2,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  getCampaignStatus,
  getNotificationRecipientStatus,
} from '@/lib/notifications/notification-status';
import type {
  NotificationCampaign,
  NotificationRecipient,
  NotificationRecipientStatus,
} from '@/lib/notifications/campaign';

const RECIPIENT_STATUSES: readonly NotificationRecipientStatus[] = [
  'pending',
  'sent',
  'failed',
  'skipped',
];

const PAGE_SIZE = 25;

interface StatCardProps {
  label: string;
  value: number;
  total: number;
  icon: React.ReactNode;
  color: string;
}

function StatCard({ label, value, total, icon, color }: StatCardProps) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <div className="flex items-center justify-between">
        <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${color}`}>
          {icon}
        </div>
        <span className="text-xs text-slate-500">{pct}%</span>
      </div>
      <p className="mt-3 text-2xl font-bold text-white">{value.toLocaleString()}</p>
      <p className="text-xs text-slate-400">{label}</p>
    </div>
  );
}

interface FunnelStep {
  label: string;
  value: number;
  color: string;
}

function FunnelChart({ steps }: { steps: FunnelStep[] }) {
  const max = Math.max(...steps.map((s) => s.value), 1);
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
      <h3 className="mb-4 text-sm font-medium text-white">Funnel</h3>
      <div className="space-y-2">
        {steps.map((step) => {
          const pctOfMax = Math.max(5, Math.round((step.value / max) * 100));
          const pctOfTotal =
            steps[0].value > 0
              ? Math.round((step.value / steps[0].value) * 100)
              : 0;
          return (
            <div key={step.label} className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-xs text-slate-400">
                {step.label}
              </span>
              <div className="relative h-7 flex-1 rounded-full bg-slate-800">
                <div
                  className={`h-7 rounded-full ${step.color} transition-[width] duration-500`}
                  style={{ width: `${pctOfMax}%` }}
                />
                <span className="absolute inset-0 flex items-center px-3 text-xs font-medium text-white">
                  {step.value.toLocaleString()}
                  <span className="ml-2 text-slate-300/80">
                    ({pctOfTotal}%)
                  </span>
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function toCsv(rows: string[][]): string {
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return rows.map((r) => r.map(escape).join(',')).join('\n');
}

function downloadBlob(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSec = seconds % 60;
  return `${minutes}m ${remainingSec}s`;
}

export default function NotificationDetailPage() {
  const params = useParams();
  const router = useRouter();
  const campaignId = params.id as string;

  const [campaign, setCampaign] = useState<NotificationCampaign | null>(null);
  const [recipients, setRecipients] = useState<NotificationRecipient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<
    NotificationRecipientStatus | 'all'
  >('all');
  const [page, setPage] = useState(1);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    async function fetchData() {
      try {
        const supabase = createClient();

        const { data: camp, error: campError } = await supabase
          .from('notification_campaigns')
          .select('*')
          .eq('id', campaignId)
          .single();

        if (campError) throw campError;
        setCampaign(camp as NotificationCampaign);

        const { data: recs, error: recsError } = await supabase
          .from('notification_recipients')
          .select('*')
          .eq('campaign_id', campaignId)
          .order('created_at', { ascending: false });

        if (recsError) throw recsError;
        setRecipients((recs as NotificationRecipient[]) ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load campaign');
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [campaignId]);

  // Reset page when filter changes
  useEffect(() => {
    setPage(1);
  }, [statusFilter]);

  const filteredRecipients = useMemo(
    () =>
      statusFilter === 'all'
        ? recipients
        : recipients.filter((r) => r.status === statusFilter),
    [recipients, statusFilter],
  );

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filteredRecipients.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const startIndex = (safePage - 1) * PAGE_SIZE;
  const endIndex = Math.min(startIndex + PAGE_SIZE, filteredRecipients.length);
  const paged = filteredRecipients.slice(startIndex, endIndex);

  // Campaign duration
  const campaignDuration = useMemo(() => {
    if (!campaign?.completed_at) return null;
    const start = new Date(campaign.created_at).getTime();
    const end = new Date(campaign.completed_at).getTime();
    return end - start;
  }, [campaign?.created_at, campaign?.completed_at]);

  // Delivery rate — FCM Accepted / Total Targeted (the only reliable rate)
  const fcmAcceptRate = useMemo(() => {
    if (!campaign || campaign.total_targeted === 0) return 0;
    return Math.round((campaign.sent_count / campaign.total_targeted) * 100);
  }, [campaign]);

  function handleExport() {
    if (!campaign) return;
    const header = [
      'User ID',
      'Status',
      'Provider Message ID',
      'Error Message',
      'Sent At',
      'Failed At',
    ];
    const rows = recipients.map((r) => [
      r.user_id,
      r.status,
      r.provider_message_id ?? '',
      r.error_message ?? '',
      r.sent_at ?? '',
      r.failed_at ?? '',
    ]);
    const csv = toCsv([header, ...rows]);
    const safeName = campaign.title.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
    downloadBlob(
      `notification-${safeName}-${campaignId.slice(0, 8)}.csv`,
      csv,
    );
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      const res = await fetch(`/api/notifications/campaigns/${campaignId}`, {
        method: 'DELETE',
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error ?? 'Failed to delete');
        return;
      }
      toast.success('Campaign deleted');
      router.push('/notifications/history');
    } catch {
      toast.error('Failed to delete campaign');
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error || !campaign) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-red-400">{error ?? 'Campaign not found'}</p>
        <Button
          variant="outline"
          onClick={() => router.push('/notifications/history')}
        >
          Back to History
        </Button>
      </div>
    );
  }

  const status = getCampaignStatus(campaign.status);

  // Funnel: Targeted → FCM Accepted → Failed → Skipped
  // Only "Targeted" and "FCM Accepted" represent real forward progress.
  // "Failed" and "Skipped" are side-branches, not funnel stages —
  // but we show them for completeness matching the broadcast pattern.
  const funnelSteps: FunnelStep[] = [
    { label: 'Targeted', value: campaign.total_targeted, color: 'bg-slate-500' },
    { label: 'FCM Accepted', value: campaign.sent_count, color: 'bg-primary' },
    { label: 'Failed', value: campaign.failed_count, color: 'bg-red-500' },
    { label: 'Skipped', value: campaign.skipped_count, color: 'bg-amber-500' },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-4">
          <Button
            variant="outline"
            size="icon"
            onClick={() => router.push('/notifications/history')}
            className="border-slate-700"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-white">{campaign.title}</h1>
              <span
                className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${status.classes}`}
              >
                {status.label}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-slate-400">
              <span>Target: {campaign.target}</span>
              {campaign.category && <span>Category: {campaign.category}</span>}
            </div>
          </div>
        </div>

        {confirmDelete ? (
          <div className="flex items-center gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-sm">
            <span className="text-red-300">Delete this campaign?</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmDelete(false)}
              disabled={deleting}
              className="h-7 border-slate-700 bg-transparent text-slate-300 hover:bg-slate-800"
            >
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleDelete}
              disabled={deleting}
              className="h-7 bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
            >
              {deleting ? 'Deleting...' : 'Confirm'}
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled={campaign.status === 'sending'}
            onClick={() => setConfirmDelete(true)}
            className="border-red-500/30 bg-transparent text-red-400 hover:bg-red-500/10 disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </Button>
        )}
      </div>

      {/* Message preview */}
      {(campaign.message || campaign.image_url) && (
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <h3 className="mb-2 text-sm font-medium text-slate-400">
            Notification Content
          </h3>
          <p className="text-sm text-white whitespace-pre-wrap">{campaign.message}</p>
          {campaign.image_url && (
            <div className="mt-3 flex items-center gap-2 text-xs text-slate-400">
              <Paperclip className="h-3.5 w-3.5" />
              <span>Image attached</span>
            </div>
          )}
        </div>
      )}

      {/* Campaign Timing */}
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
        <h3 className="mb-3 text-sm font-medium text-white flex items-center gap-2">
          <Clock className="h-4 w-4 text-slate-400" />
          Campaign Timing
        </h3>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div>
            <p className="text-xs text-slate-500">Created</p>
            <p className="mt-0.5 text-sm text-white">
              {new Date(campaign.created_at).toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Sending Started</p>
            <p className="mt-0.5 text-sm text-white">
              {new Date(campaign.created_at).toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Completed</p>
            <p className="mt-0.5 text-sm text-white">
              {campaign.completed_at
                ? new Date(campaign.completed_at).toLocaleString()
                : 'In progress...'}
            </p>
          </div>
          <div>
            <p className="text-xs text-slate-500">Total Duration</p>
            <p className="mt-0.5 text-sm text-white">
              {campaignDuration !== null ? formatDuration(campaignDuration) : '---'}
            </p>
          </div>
        </div>
        {/* Acceptance rate */}
        <div className="mt-3 flex items-center gap-2 text-xs text-slate-400">
          <CheckCircle2 className="h-3.5 w-3.5" />
          <span>
            FCM Accept Rate: {fcmAcceptRate}% ({campaign.sent_count.toLocaleString()} of{' '}
            {campaign.total_targeted.toLocaleString()} targeted)
          </span>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label="Total Targeted"
          value={campaign.total_targeted}
          total={campaign.total_targeted}
          icon={<Users className="h-4 w-4" />}
          color="bg-slate-800 text-slate-300"
        />
        <StatCard
          label="FCM Accepted"
          value={campaign.sent_count}
          total={campaign.total_targeted}
          icon={<Send className="h-4 w-4" />}
          color="bg-primary/10 text-primary"
        />
        <StatCard
          label="Failed"
          value={campaign.failed_count}
          total={campaign.total_targeted}
          icon={<AlertCircle className="h-4 w-4" />}
          color="bg-red-500/10 text-red-400"
        />
        <StatCard
          label="Skipped (no token)"
          value={campaign.skipped_count}
          total={campaign.total_targeted}
          icon={<Users className="h-4 w-4" />}
          color="bg-amber-500/10 text-amber-400"
        />
      </div>

      <FunnelChart steps={funnelSteps} />

      {/* Recipients Table */}
      <div className="rounded-xl border border-slate-800 bg-slate-900">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-4 py-3">
          <h2 className="text-sm font-medium text-white">
            Recipients ({filteredRecipients.length}
            {statusFilter !== 'all' ? ` of ${recipients.length}` : ''})
          </h2>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-slate-700 text-slate-300 hover:bg-slate-800"
                  />
                }
              >
                <Filter className="h-3.5 w-3.5" />
                {statusFilter === 'all'
                  ? 'All statuses'
                  : getNotificationRecipientStatus(statusFilter).label}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="border-slate-700 bg-slate-900">
                <DropdownMenuItem
                  onClick={() => setStatusFilter('all')}
                  className={
                    statusFilter === 'all' ? 'text-primary' : 'text-slate-300'
                  }
                >
                  All statuses
                </DropdownMenuItem>
                {RECIPIENT_STATUSES.map((s) => (
                  <DropdownMenuItem
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    className={
                      statusFilter === s ? 'text-primary' : 'text-slate-300'
                    }
                  >
                    {getNotificationRecipientStatus(s).label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            <Button
              variant="outline"
              size="sm"
              onClick={handleExport}
              disabled={recipients.length === 0}
              className="border-slate-700 text-slate-300 hover:bg-slate-800"
            >
              <Download className="h-3.5 w-3.5" />
              Export CSV
            </Button>
          </div>
        </div>

        {paged.length === 0 ? (
          <div className="flex h-32 items-center justify-center">
            <p className="text-sm text-slate-400">
              {recipients.length === 0
                ? 'No recipients found.'
                : 'No recipients match this filter.'}
            </p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="border-slate-800 hover:bg-transparent">
                    <TableHead className="text-slate-400">User ID</TableHead>
                    <TableHead className="text-slate-400">Status</TableHead>
                    <TableHead className="text-slate-400">Sent At</TableHead>
                    <TableHead className="hidden text-slate-400 md:table-cell">
                      FCM Message ID
                    </TableHead>
                    <TableHead className="text-slate-400">Error</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paged.map((recipient) => {
                    const rStatus = getNotificationRecipientStatus(
                      recipient.status,
                    );
                    return (
                      <TableRow
                        key={recipient.id}
                        className="border-slate-800"
                      >
                        <TableCell className="font-mono text-xs text-white">
                          {recipient.user_id}
                        </TableCell>
                        <TableCell>
                          <span
                            className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${rStatus.classes}`}
                          >
                            {rStatus.label}
                          </span>
                        </TableCell>
                        <TableCell className="text-xs text-slate-400">
                          {recipient.sent_at
                            ? new Date(recipient.sent_at).toLocaleString()
                            : recipient.failed_at
                              ? new Date(recipient.failed_at).toLocaleString()
                              : '-'}
                        </TableCell>
                        <TableCell className="hidden max-w-xs truncate font-mono text-xs text-slate-400 md:table-cell">
                          {recipient.provider_message_id ?? '-'}
                        </TableCell>
                        <TableCell className="max-w-xs truncate text-xs text-red-400">
                          {recipient.error_message ?? '-'}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between border-t border-slate-800 px-4 py-3">
                <span className="text-xs text-slate-400">
                  Showing {startIndex + 1}–{endIndex} of{' '}
                  {filteredRecipients.length}
                </span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400">
                    Page {safePage} of {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setPage(safePage - 1)}
                    disabled={safePage <= 1}
                    className="h-7 w-7 border-slate-700 text-slate-300 hover:bg-slate-800"
                  >
                    <ChevronLeft className="size-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setPage(safePage + 1)}
                    disabled={safePage >= totalPages}
                    className="h-7 w-7 border-slate-700 text-slate-300 hover:bg-slate-800"
                  >
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
