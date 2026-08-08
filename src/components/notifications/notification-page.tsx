'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { syncUsers } from '@/lib/notifications/sync-users';
import { sendNotification } from '@/lib/notifications/send-notifications';
import {
  DEFAULT_PAGE_SIZE,
  filterUsers,
  hasActiveFilters,
  paginateUsers,
  summarizeSyncResult,
  summarizeUsers,
  toggleIds,
} from '@/lib/notifications/user-list';
import type { NotificationPayload, NotificationUser } from '@/types';
import { UserToolbar } from '@/components/notifications/user-toolbar';
import { UserTable } from '@/components/notifications/user-table';
import { SendNotificationModal } from '@/components/notifications/send-notification-modal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

export function NotificationPage() {
  const supabase = createClient();

  const [users, setUsers] = useState<NotificationUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [modalOpen, setModalOpen] = useState(false);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) {
      toast.error('Failed to load users');
      setLoading(false);
      return;
    }

    setUsers((data as NotificationUser[]) ?? []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  // Changing the filter or page size restarts from the first page.
  useEffect(() => {
    setPage(1);
  }, [search, category, pageSize]);

  const filtered = useMemo(
    () => filterUsers(users, { search, category }),
    [users, search, category],
  );

  const paginated = useMemo(
    () => paginateUsers(filtered, page, pageSize),
    [filtered, page, pageSize],
  );

  const filteredIds = useMemo(() => filtered.map((user) => user.id), [filtered]);
  const pageIds = useMemo(() => paginated.items.map((user) => user.id), [paginated.items]);

  const summary = useMemo(
    () => summarizeUsers(filtered, selectedIds),
    [filtered, selectedIds],
  );

  const filtersActive = hasActiveFilters({ search, category });

  const pageAllSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  const pageSomeSelected = pageIds.some((id) => selectedIds.has(id));
  const allFilteredSelected =
    filteredIds.length > 0 && filteredIds.every((id) => selectedIds.has(id));

  function handleToggleAll(checked: boolean) {
    setSelectedIds((prev) => toggleIds(prev, pageIds, checked));
  }

  function handleToggleUser(id: string, checked: boolean) {
    setSelectedIds((prev) => toggleIds(prev, [id], checked));
  }

  function handleSelectAllFiltered() {
    setSelectedIds((prev) => toggleIds(prev, filteredIds, true));
  }

  function handleClearSelection() {
    setSelectedIds(new Set());
  }

  async function handleSync() {
    setSyncing(true);
    try {
      const result = await syncUsers();
      await fetchUsers();
      toast.success(summarizeSyncResult(result));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to synchronize users');
    } finally {
      setSyncing(false);
    }
  }

  function handleClearFilters() {
    setSearch('');
    setCategory('all');
  }

  async function handleSend(payload: NotificationPayload) {
    try {
      const result = await sendNotification(payload);
      if (result.failed > 0) {
        toast.success(
          `Accepted by Firebase: ${result.sent} sent, ${result.failed} failed`,
        );
      } else {
        toast.success(
          `Sent successfully to ${result.sent} user${result.sent === 1 ? '' : 's'}.`,
        );
      }
      if (result.failedUsers.length > 0) {
        toast.error(
          `Failed for ${result.failedUsers.length} user(s): ${result.failedUsers.join(', ')}`,
        );
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to send notification');
      throw error;
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Notifications</h1>
        <p className="mt-1 text-sm text-slate-400">
          Manage users and send push notifications.
        </p>
      </div>

      <UserToolbar
        search={search}
        onSearchChange={setSearch}
        category={category}
        onCategoryChange={setCategory}
        syncing={syncing}
        onSyncClick={handleSync}
        onSendClick={() => setModalOpen(true)}
        totalCount={users.length}
        filteredCount={filtered.length}
        selectedCount={summary.selected}
        hasActiveFilters={filtersActive}
        onClearFilters={handleClearFilters}
      />

      <div className="flex flex-wrap items-center gap-2" aria-label="User summary">
        <Badge variant="secondary">Total: {users.length}</Badge>
        <Badge variant="secondary">Filtered: {filtered.length}</Badge>
        <Badge variant="secondary">Selected: {summary.selected}</Badge>
        <Badge variant="secondary">FCM Ready: {summary.fcmReady}</Badge>
        <Badge variant="secondary">Missing FCM: {summary.missingFcm}</Badge>
      </div>

      {summary.selected > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-800 bg-slate-900 px-3 py-2">
          <span className="text-sm text-slate-300">
            {summary.selected} user{summary.selected === 1 ? '' : 's'} selected
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {allFilteredSelected ? (
              <span className="text-xs text-emerald-400">
                All {filtered.length} filtered users selected
              </span>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={handleSelectAllFiltered}
                className="border-slate-700 text-slate-300 hover:bg-slate-800"
              >
                Select all {filtered.length} filtered users
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleClearSelection}
              className="border-slate-700 text-slate-300 hover:bg-slate-800"
            >
              Clear selection
            </Button>
            <Button size="sm" onClick={() => setModalOpen(true)}>
              Send to {summary.selected}
            </Button>
          </div>
        </div>
      )}

      <UserTable
        users={paginated.items}
        loading={loading}
        totalFiltered={filtered.length}
        selectedIds={selectedIds}
        allSelected={pageAllSelected}
        someSelected={pageSomeSelected}
        onToggle={handleToggleUser}
        onToggleAll={handleToggleAll}
        hasFilters={filtersActive}
        onClearFilters={handleClearFilters}
        pagination={{
          page: paginated.page,
          pageSize: paginated.pageSize,
          totalPages: paginated.totalPages,
          startIndex: paginated.startIndex,
          endIndex: paginated.endIndex,
          onPageChange: setPage,
          onPageSizeChange: setPageSize,
        }}
      />

      <SendNotificationModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        selectedUserIds={Array.from(selectedIds)}
        onSend={handleSend}
      />
    </div>
  );
}
