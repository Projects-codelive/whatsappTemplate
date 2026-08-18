'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
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
  ArrowLeft,
  Bell,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from 'lucide-react';
import { getCampaignStatus } from '@/lib/notifications/notification-status';
import type { NotificationCampaign } from '@/lib/notifications/campaign';

const PAGE_SIZE = 15;
const POLL_INTERVAL_MS = 5_000;

function percent(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 100);
}

export default function NotificationHistoryPage() {
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<NotificationCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchCampaigns() {
    try {
      const supabase = createClient();
      const { data, error: fetchError } = await supabase
        .from('notification_campaigns')
        .select('*')
        .order('created_at', { ascending: false });

      if (fetchError) throw fetchError;
      setCampaigns((data as NotificationCampaign[]) ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load campaigns');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchCampaigns();
  }, []);

  const anySending = useMemo(
    () => campaigns.some((c) => c.status === 'sending'),
    [campaigns],
  );

  useEffect(() => {
    function startPolling() {
      if (pollTimer.current) return;
      pollTimer.current = setInterval(fetchCampaigns, POLL_INTERVAL_MS);
    }
    function stopPolling() {
      if (!pollTimer.current) return;
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }

    function handleVisibilityChange() {
      if (!anySending) return;
      if (document.visibilityState === 'hidden') {
        stopPolling();
      } else {
        fetchCampaigns();
        startPolling();
      }
    }

    if (anySending && document.visibilityState === 'visible') {
      startPolling();
    } else {
      stopPolling();
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [anySending]);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(campaigns.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const startIndex = (safePage - 1) * PAGE_SIZE;
  const endIndex = Math.min(startIndex + PAGE_SIZE, campaigns.length);
  const paged = campaigns.slice(startIndex, endIndex);

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
      <div className="flex items-center gap-4">
        <Button
          variant="outline"
          size="icon"
          onClick={() => router.push('/notifications')}
          className="border-slate-700"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div>
          <h1 className="text-2xl font-bold text-white">Notification History</h1>
          <p className="mt-1 text-sm text-slate-400">
            Past notification campaigns and their delivery status.
          </p>
        </div>
      </div>

      {campaigns.length === 0 ? (
        <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-slate-800 bg-slate-900">
          <Bell className="mb-3 h-10 w-10 text-slate-600" />
          <p className="text-sm font-medium text-white">No campaigns yet</p>
          <p className="mt-1 text-xs text-slate-400">
            Send a notification to see it appear here.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900">
          <Table>
            <TableHeader>
              <TableRow className="border-slate-800 hover:bg-transparent">
                <TableHead className="text-slate-400">Title</TableHead>
                <TableHead className="hidden text-slate-400 md:table-cell">
                  Target
                </TableHead>
                <TableHead className="hidden text-right text-slate-400 sm:table-cell">
                  Total
                </TableHead>
                <TableHead className="hidden text-slate-400 lg:table-cell">
                  Sent
                </TableHead>
                <TableHead className="hidden text-slate-400 lg:table-cell">
                  Failed
                </TableHead>
                <TableHead className="hidden text-slate-400 lg:table-cell">
                  Skipped
                </TableHead>
                <TableHead className="text-slate-400">Status</TableHead>
                <TableHead className="hidden text-slate-400 sm:table-cell">
                  Date
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {paged.map((campaign) => {
                const status = getCampaignStatus(campaign.status);
                return (
                  <TableRow
                    key={campaign.id}
                    className="cursor-pointer border-slate-800 hover:bg-slate-800/50"
                    onClick={() => router.push(`/notifications/${campaign.id}`)}
                  >
                    <TableCell className="font-medium text-white">
                      {campaign.title}
                    </TableCell>
                    <TableCell className="hidden text-slate-300 md:table-cell">
                      {campaign.target}
                      {campaign.category ? ` (${campaign.category})` : ''}
                    </TableCell>
                    <TableCell className="hidden text-right text-slate-300 tabular-nums sm:table-cell">
                      {campaign.total_targeted}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <div className="flex items-center gap-2">
                        <span className="w-10 text-right text-xs tabular-nums text-slate-300">
                          {percent(campaign.sent_count, campaign.total_targeted)}%
                        </span>
                        <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-800">
                          <div
                            className="h-1.5 rounded-full bg-primary"
                            style={{
                              width: `${percent(campaign.sent_count, campaign.total_targeted)}%`,
                            }}
                          />
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-slate-400 lg:table-cell">
                      {campaign.failed_count}
                    </TableCell>
                    <TableCell className="hidden text-slate-400 lg:table-cell">
                      {campaign.skipped_count}
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
                      {new Date(campaign.created_at).toLocaleDateString()}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-slate-800 px-4 py-3">
              <span className="text-xs text-slate-400">
                Showing {startIndex + 1}–{endIndex} of {campaigns.length}
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
        </div>
      )}
    </div>
  );
}
