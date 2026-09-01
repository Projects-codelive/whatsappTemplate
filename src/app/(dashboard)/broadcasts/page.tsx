'use client';

import { useCallback, useEffect, useState, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Broadcast, BroadcastStatus } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import {
  Radio,
  Plus,
  Loader2,
  Search,
  MoreHorizontal,
  Copy,
  Trash2,
  Filter,
  ChevronDown,
  Pause,
  Play,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import { getBroadcastStatus, broadcastStatusConfig } from '@/lib/broadcast-status';
import { useBroadcastSending } from '@/hooks/use-broadcast-sending';
import { useBroadcastRealtime } from '@/hooks/use-broadcast-realtime';

const BROADCAST_STATUSES: BroadcastStatus[] = [
  'draft',
  'scheduled',
  'sending',
  'sent',
  'failed',
  'paused',
  'cancelled',
];

/**
 * Poll cadence while any broadcast is sending. Kept modest so we don't
 * beat on Supabase — the aggregate trigger in migration 003 keeps
 * counts consistent; we just need to surface the freshest snapshot.
 */
const POLL_INTERVAL_MS = 5_000;

function percent(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 100);
}

function RateCell({
  value,
  total,
  color,
}: {
  value: number;
  total: number;
  /** Tailwind bg class for the fill, e.g. "bg-primary" */
  color: string;
}) {
  const pct = percent(value, total);
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 text-right text-xs tabular-nums text-slate-300">
        {pct}%
      </span>
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-800">
        <div
          className={`h-1.5 rounded-full ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export default function BroadcastsPage() {
  const router = useRouter();
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Search & filter
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<BroadcastStatus | 'all'>('all');

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  // Row-level delete confirm
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Row-level status transitions (pause/resume/cancel/resend)
  const [rowActionId, setRowActionId] = useState<string | null>(null);
  const [cancelTarget, setCancelTarget] = useState<Broadcast | null>(null);
  const [resendTarget, setResendTarget] = useState<Broadcast | null>(null);
  const [resending, setResending] = useState(false);
  const { sendPreparedBroadcast } = useBroadcastSending();

  // Clear selection when search or filter changes
  const prevSearchRef = useRef(search);
  const prevStatusRef = useRef(statusFilter);
  if (search !== prevSearchRef.current || statusFilter !== prevStatusRef.current) {
    prevSearchRef.current = search;
    prevStatusRef.current = statusFilter;
    if (selectedIds.size > 0) setSelectedIds(new Set());
  }

  // Used to kick off polling only while something is actively sending.
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchBroadcasts() {
    try {
      const supabase = createClient();
      const { data, error: fetchError } = await supabase
        .from('broadcasts')
        .select('*')
        .order('created_at', { ascending: false });

      if (fetchError) throw fetchError;
      setBroadcasts(data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load broadcasts');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchBroadcasts();
  }, []);

  const anySending = useMemo(
    () => broadcasts.some((b) => b.status === 'sending'),
    [broadcasts],
  );

  const anyActive = useMemo(
    () =>
      broadcasts.some(
        (b) =>
          b.status === 'scheduled' ||
          b.status === 'sending' ||
          b.status === 'paused',
      ),
    [broadcasts],
  );

  const fetchBroadcastsRef = useRef(fetchBroadcasts);
  fetchBroadcastsRef.current = fetchBroadcasts;

  // Realtime: subscribe to broadcasts changes for the current user.
  // Any INSERT/UPDATE/DELETE triggers an immediate refetch instead of
  // waiting for the polling interval.
  useBroadcastRealtime({
    subscribeToBroadcast: true,
    onBroadcastEvent: useCallback(() => {
      fetchBroadcastsRef.current();
    }, []),
    enabled: anyActive,
  });

  const filteredBroadcasts = useMemo(() => {
    let result = broadcasts;
    if (statusFilter !== 'all') {
      result = result.filter((b) => b.status === statusFilter);
    }
    if (search.trim()) {
      const term = search.trim().toLowerCase();
      result = result.filter(
        (b) =>
          b.name.toLowerCase().includes(term) ||
          b.template_name.toLowerCase().includes(term),
      );
    }
    return result;
  }, [broadcasts, search, statusFilter]);

  const allVisibleSelected =
    filteredBroadcasts.length > 0 &&
    filteredBroadcasts.every((b) => selectedIds.has(b.id));

  const sendingBroadcastCount = useMemo(() => {
    if (selectedIds.size === 0) return 0;
    const broadcastMap = new Map(broadcasts.map((b) => [b.id, b]));
    return Array.from(selectedIds).filter((id) => {
      const b = broadcastMap.get(id);
      return b?.status === 'sending';
    }).length;
  }, [selectedIds, broadcasts]);

  function toggleSelectAll() {
    if (allVisibleSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredBroadcasts.map((b) => b.id)));
    }
  }

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleClone(broadcast: Broadcast) {
    const params = new URLSearchParams({
      template: broadcast.template_name,
      name: `${broadcast.name} (Copy)`,
    });
    if (broadcast.audience_filter) {
      params.set('audience', JSON.stringify(broadcast.audience_filter));
    }
    if (broadcast.template_variables) {
      params.set('variables', JSON.stringify(broadcast.template_variables));
    }
    router.push(`/broadcasts/new?${params.toString()}`);
  }

  async function handleDeleteSingle(id: string) {
    setDeleting(true);
    const supabase = createClient();
    const { error } = await supabase.from('broadcasts').delete().eq('id', id);
    setDeleting(false);
    setDeleteConfirmId(null);
    if (error) {
      toast.error(`Delete failed: ${error.message}`);
      return;
    }
    toast.success('Broadcast deleted');
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    fetchBroadcasts();
  }

  /** Pause / cancel — atomic server-side status claims. Resume from the
   *  list uses the same endpoint (server sends for cron-mode; the browser
   *  tab re-picks up pending recipients for browser-mode). */
  async function runRowAction(
    id: string,
    action: 'pause' | 'resume',
  ) {
    setRowActionId(id);
    try {
      const res = await fetch(`/api/whatsapp/broadcast/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Action failed');
      toast.success(
        action === 'pause' ? 'Broadcast paused' : 'Broadcast resumed',
      );
      if (action === 'resume') await sendPreparedBroadcast(id);
      fetchBroadcasts();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setRowActionId(null);
    }
  }

  async function confirmRowCancel() {
    if (!cancelTarget) return;
    const id = cancelTarget.id;
    setRowActionId(id);
    try {
      const res = await fetch(`/api/whatsapp/broadcast/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Cancel failed');
      toast.success('Broadcast cancelled');
      setCancelTarget(null);
      fetchBroadcasts();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Cancel failed');
    } finally {
      setRowActionId(null);
    }
  }

  async function confirmRowResend() {
    if (!resendTarget) return;
    const id = resendTarget.id;
    setResending(true);
    try {
      const res = await fetch(`/api/whatsapp/broadcast/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resend' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Resend failed');
      const newId = data.broadcast_id as string;
      setResendTarget(null);
      if (data.already) {
        router.push(`/broadcasts/${newId}`);
        return;
      }
      await sendPreparedBroadcast(newId);
      toast.success(
        `Broadcast re-sent to ${(data.recipient_count ?? 0).toLocaleString()} non-responder${data.recipient_count === 1 ? '' : 's'}`,
      );
      router.push(`/broadcasts/${newId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Resend failed');
    } finally {
      setResending(false);
    }
  }

  async function handleBulkDelete() {
    setBulkDeleting(true);
    const supabase = createClient();

    // Filter out sending broadcasts — they must not be deleted mid-send.
    const broadcastMap = new Map(broadcasts.map((b) => [b.id, b]));
    const eligible = Array.from(selectedIds).filter((id) => {
      const b = broadcastMap.get(id);
      return b && b.status !== 'sending';
    });

    if (eligible.length === 0) {
      setBulkDeleting(false);
      setBulkDeleteOpen(false);
      toast.error('Cannot delete broadcasts that are currently sending');
      return;
    }

    const { error } = await supabase.from('broadcasts').delete().in('id', eligible);
    setBulkDeleting(false);
    setBulkDeleteOpen(false);
    if (error) {
      toast.error(`Bulk delete failed: ${error.message}`);
      return;
    }
    const skipped = selectedIds.size - eligible.length;
    toast.success(
      `${eligible.length} broadcast${eligible.length === 1 ? '' : 's'} deleted` +
        (skipped > 0 ? ` (${skipped} sending broadcast${skipped === 1 ? '' : 's'} skipped)` : ''),
    );
    setSelectedIds(new Set());
    fetchBroadcasts();
  }

  useEffect(() => {
    function startPolling() {
      if (pollTimer.current) return;
      pollTimer.current = setInterval(fetchBroadcasts, POLL_INTERVAL_MS);
    }
    function stopPolling() {
      if (!pollTimer.current) return;
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }

    // Pause polling while the tab is hidden — keeps Supabase cold when
    // the user is away, and ensures a fresh fetch the moment they
    // refocus so they don't see stale data on return.
    function handleVisibilityChange() {
      if (!anyActive) return;
      if (document.visibilityState === 'hidden') {
        stopPolling();
      } else {
        fetchBroadcasts();
        startPolling();
      }
    }

    if (anyActive && document.visibilityState === 'visible') {
      startPolling();
    } else {
      stopPolling();
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [anyActive]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-red-400">{error}</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Top indeterminate progress bar */}
      {anySending && (
        <div
          role="progressbar"
          aria-label="Broadcast in progress"
          className="broadcast-indeterminate fixed inset-x-0 top-0 z-40 h-0.5 overflow-hidden bg-slate-800"
        >
          <div className="broadcast-indeterminate-bar h-0.5 bg-primary" />
          <style jsx>{`
            .broadcast-indeterminate-bar {
              width: 33%;
              transform: translateX(-100%);
              animation: broadcast-slide 1.6s cubic-bezier(0.4, 0, 0.2, 1)
                infinite;
            }
            @keyframes broadcast-slide {
              0% {
                transform: translateX(-100%);
              }
              100% {
                transform: translateX(400%);
              }
            }
          `}</style>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Broadcasts</h1>
          <p className="mt-1 text-sm text-slate-400">
            Send bulk messages to your contacts using approved templates.
          </p>
        </div>
        <Button
          onClick={() => router.push('/broadcasts/new')}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          <Plus className="h-4 w-4" />
          New Broadcast
        </Button>
      </div>

      {/* Search & Filter bar — only shown when there are broadcasts */}
      {broadcasts.length > 0 && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative max-w-sm flex-1">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or template..."
              className="border-slate-700 bg-slate-900 pl-8 text-white placeholder:text-slate-500"
            />
          </div>
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
                : broadcastStatusConfig[statusFilter].label}
              <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="border-slate-700 bg-slate-900">
              <DropdownMenuItem
                onClick={() => setStatusFilter('all')}
                className={statusFilter === 'all' ? 'text-primary' : 'text-slate-300'}
              >
                All statuses
              </DropdownMenuItem>
              {BROADCAST_STATUSES.map((s) => (
                <DropdownMenuItem
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={statusFilter === s ? 'text-primary' : 'text-slate-300'}
                >
                  {broadcastStatusConfig[s].label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      {/* Bulk actions toolbar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-2.5">
          <span className="text-sm text-slate-300">
            {selectedIds.size} selected
            {sendingBroadcastCount > 0 && (
              <span className="ml-1 text-yellow-400">
                ({sendingBroadcastCount} sending — will be skipped)
              </span>
            )}
          </span>
          <div className="ml-auto">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setBulkDeleteOpen(true)}
              className="border-red-500/30 bg-transparent text-red-400 hover:bg-red-500/10"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete selected
            </Button>
          </div>
        </div>
      )}

      {broadcasts.length === 0 ? (
        <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-slate-800 bg-slate-900">
          <Radio className="mb-3 h-10 w-10 text-slate-600" />
          <p className="text-sm font-medium text-white">No broadcasts yet</p>
          <p className="mt-1 text-xs text-slate-400">
            Create your first broadcast to reach your contacts at scale.
          </p>
          <Button
            onClick={() => router.push('/broadcasts/new')}
            className="mt-4 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            New Broadcast
          </Button>
        </div>
      ) : filteredBroadcasts.length === 0 ? (
        <div className="flex h-32 items-center justify-center rounded-xl border border-slate-800 bg-slate-900">
          <p className="text-sm text-slate-400">
            No broadcasts match your search or filter.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900">
          <Table>
            <TableHeader>
              <TableRow className="border-slate-800 hover:bg-transparent">
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAll}
                    className="h-4 w-4 rounded border-slate-600 bg-slate-800 accent-primary"
                  />
                </TableHead>
                <TableHead className="text-slate-400">Name</TableHead>
                <TableHead className="hidden text-slate-400 md:table-cell">Template</TableHead>
                <TableHead className="hidden text-right text-slate-400 sm:table-cell">
                  Recipients
                </TableHead>
                <TableHead className="hidden text-slate-400 lg:table-cell">Delivery</TableHead>
                <TableHead className="hidden text-slate-400 lg:table-cell">Read</TableHead>
                <TableHead className="text-slate-400">Status</TableHead>
                <TableHead className="hidden text-slate-400 sm:table-cell">Date</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredBroadcasts.map((broadcast) => {
                const status = getBroadcastStatus(broadcast.status);
                const deleteConfirm = deleteConfirmId === broadcast.id;
                return (
                  <TableRow
                    key={broadcast.id}
                    className="cursor-pointer border-slate-800 hover:bg-slate-800/50"
                    onClick={() => router.push(`/broadcasts/${broadcast.id}`)}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(broadcast.id)}
                        onChange={() => toggleSelect(broadcast.id)}
                        className="h-4 w-4 rounded border-slate-600 bg-slate-800 accent-primary"
                      />
                    </TableCell>
                    <TableCell className="font-medium text-white">
                      {broadcast.name}
                    </TableCell>
                    <TableCell className="hidden text-slate-300 md:table-cell">
                      {broadcast.template_name}
                    </TableCell>
                    <TableCell className="hidden text-right text-slate-300 tabular-nums sm:table-cell">
                      {broadcast.total_recipients}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <RateCell
                        value={broadcast.delivered_count}
                        total={broadcast.total_recipients}
                        color="bg-primary"
                      />
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <RateCell
                        value={broadcast.read_count}
                        total={broadcast.total_recipients}
                        color="bg-blue-500"
                      />
                    </TableCell>
                    <TableCell>
                      <span
                        className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${status.classes}`}
                      >
                        {status.pulse && (
                          <span className="relative flex h-1.5 w-1.5">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-yellow-400 opacity-75" />
                            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-yellow-400" />
                          </span>
                        )}
                        {status.label}
                      </span>
                    </TableCell>
                    <TableCell className="hidden text-slate-400 sm:table-cell">
                      {broadcast.scheduled_at
                        ? `Scheduled ${new Date(broadcast.scheduled_at).toLocaleString()}`
                        : new Date(broadcast.created_at).toLocaleDateString()}
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      {deleteConfirm ? (
                        <div className="flex items-center gap-1">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setDeleteConfirmId(null)}
                            disabled={deleting}
                            className="h-6 border-slate-700 bg-transparent px-1.5 text-[10px] text-slate-400 hover:bg-slate-800"
                          >
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            onClick={() => handleDeleteSingle(broadcast.id)}
                            disabled={deleting}
                            className="h-6 bg-red-600 px-1.5 text-[10px] text-white hover:bg-red-700 disabled:opacity-50"
                          >
                            {deleting ? '...' : 'Confirm'}
                          </Button>
                        </div>
                      ) : (
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                className="text-slate-400 hover:text-white"
                              />
                            }
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            align="end"
                            className="border-slate-700 bg-slate-900"
                          >
                            <DropdownMenuItem
                              onClick={() => handleClone(broadcast)}
                              className="text-slate-300 focus:bg-slate-800 focus:text-white"
                            >
                              <Copy className="h-4 w-4" />
                              Clone
                            </DropdownMenuItem>

                            {broadcast.status === 'sending' && (
                              <DropdownMenuItem
                                onClick={() =>
                                  runRowAction(broadcast.id, 'pause')
                                }
                                disabled={rowActionId === broadcast.id}
                                className="text-slate-300 focus:bg-slate-800 focus:text-white"
                              >
                                <Pause className="h-4 w-4" />
                                Pause
                              </DropdownMenuItem>
                            )}

                            {broadcast.status === 'paused' && (
                              <DropdownMenuItem
                                onClick={() =>
                                  runRowAction(broadcast.id, 'resume')
                                }
                                disabled={rowActionId === broadcast.id}
                                className="text-slate-300 focus:bg-slate-800 focus:text-white"
                              >
                                <Play className="h-4 w-4" />
                                Resume
                              </DropdownMenuItem>
                            )}

                            {(broadcast.status === 'scheduled' ||
                              broadcast.status === 'sending' ||
                              broadcast.status === 'paused') && (
                              <DropdownMenuItem
                                variant="destructive"
                                onClick={() => setCancelTarget(broadcast)}
                                disabled={rowActionId === broadcast.id}
                              >
                                <XCircle className="h-4 w-4" />
                                Cancel
                              </DropdownMenuItem>
                            )}

                            {(broadcast.status === 'sent' ||
                              broadcast.status === 'failed' ||
                              broadcast.status === 'cancelled') && (
                              <DropdownMenuItem
                                onClick={() => setResendTarget(broadcast)}
                                disabled={rowActionId === broadcast.id}
                                className="text-slate-300 focus:bg-slate-800 focus:text-white"
                              >
                                <RotateCcw className="h-4 w-4" />
                                Resend to Non-Responders
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator className="bg-slate-700" />
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => setDeleteConfirmId(broadcast.id)}
                              disabled={broadcast.status === 'sending'}
                            >
                              <Trash2 className="h-4 w-4" />
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Bulk delete confirmation dialog */}
      <Dialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <DialogContent className="border-slate-700 bg-slate-900 text-slate-200 sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-white">Delete Broadcasts</DialogTitle>
            <DialogDescription className="text-slate-400">
              {sendingBroadcastCount > 0 ? (
                <>
                  Delete {selectedIds.size - sendingBroadcastCount} broadcast
                  {selectedIds.size - sendingBroadcastCount === 1 ? '' : 's'}?
                  {sendingBroadcastCount} sending broadcast
                  {sendingBroadcastCount === 1 ? '' : 's'} will be skipped.
                  This action cannot be undone.
                </>
              ) : (
                <>
                  Are you sure you want to delete {selectedIds.size} broadcast
                  {selectedIds.size === 1 ? '' : 's'}? This action cannot be undone.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="border-slate-700 bg-slate-900">
            <Button
              variant="outline"
              onClick={() => setBulkDeleteOpen(false)}
              disabled={bulkDeleting}
              className="border-slate-700 text-slate-300 hover:bg-slate-800"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleBulkDelete}
              disabled={bulkDeleting || selectedIds.size - sendingBroadcastCount === 0}
            >
              {bulkDeleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete {selectedIds.size - sendingBroadcastCount} broadcast
              {selectedIds.size - sendingBroadcastCount === 1 ? '' : 's'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Row cancel confirmation */}
      <Dialog open={!!cancelTarget} onOpenChange={(o) => !o && setCancelTarget(null)}>
        <DialogContent className="border-slate-700 bg-slate-900 text-slate-200 sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-white">Cancel Broadcast</DialogTitle>
            <DialogDescription className="text-slate-400">
              Stop{' '}
              <span className="font-medium text-white">{cancelTarget?.name}</span>{' '}
              now? Recipients already sent keep their status; unsent recipients
              stay unsent. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCancelTarget(null)}
              disabled={rowActionId === cancelTarget?.id}
              className="border-slate-700 text-slate-300 hover:bg-slate-800"
            >
              Keep going
            </Button>
            <Button
              variant="destructive"
              onClick={confirmRowCancel}
              disabled={rowActionId === cancelTarget?.id}
            >
              {rowActionId === cancelTarget?.id && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Cancel broadcast
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Row resend confirmation */}
      <Dialog open={!!resendTarget} onOpenChange={(o) => !o && setResendTarget(null)}>
        <DialogContent className="border-slate-700 bg-slate-900 text-slate-200 sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-white">
              Resend to Non-Responders
            </DialogTitle>
            <DialogDescription className="text-slate-400">
              Send{' '}
              <span className="font-medium text-white">
                {resendTarget?.template_name}
              </span>{' '}
              again to the contacts who received it but never replied.
              Responders and never-received or failed contacts are excluded.
              This creates a new broadcast.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setResendTarget(null)}
              disabled={resending}
              className="border-slate-700 text-slate-300 hover:bg-slate-800"
            >
              Cancel
            </Button>
            <Button
              onClick={confirmRowResend}
              disabled={resending}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {resending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              <RotateCcw className="mr-2 h-4 w-4" />
              Resend
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
