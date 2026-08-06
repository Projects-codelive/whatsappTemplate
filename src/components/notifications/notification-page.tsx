'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { syncUsers } from '@/lib/notifications/sync-users';
import { sendNotification } from '@/lib/notifications/send-notifications';
import type { NotificationPayload, NotificationUser } from '@/types';
import { UserToolbar } from '@/components/notifications/user-toolbar';
import { UserTable } from '@/components/notifications/user-table';
import { SendNotificationModal } from '@/components/notifications/send-notification-modal';

export function NotificationPage() {
  const supabase = createClient();

  const [users, setUsers] = useState<NotificationUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
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

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return users.filter((user) => {
      const matchesSearch =
        query === '' ||
        (user.name ?? '').toLowerCase().includes(query) ||
        (user.mobile ?? '').toLowerCase().includes(query) ||
        (user.email ?? '').toLowerCase().includes(query);
      const matchesCategory = category === 'all' || user.category === category;
      return matchesSearch && matchesCategory;
    });
  }, [users, search, category]);

  const filteredIds = useMemo(() => filtered.map((user) => user.id), [filtered]);

  const allSelected = filteredIds.length > 0 && filteredIds.every((id) => selectedIds.has(id));
  const someSelected = filteredIds.some((id) => selectedIds.has(id));

  function handleToggleAll(checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        filteredIds.forEach((id) => next.add(id));
      } else {
        filteredIds.forEach((id) => next.delete(id));
      }
      return next;
    });
  }

  function handleToggleUser(id: string, checked: boolean) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  async function handleSync() {
    setSyncing(true);
    try {
      await syncUsers();
      await fetchUsers();
      toast.success('Users synchronized successfully.');
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
      toast.success(
        result.failed > 0
          ? `Notification sent: ${result.sent} delivered, ${result.failed} failed`
          : `Notification sent to ${result.sent} user${result.sent === 1 ? '' : 's'}.`,
      );
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

  const hasFilters = search.trim() !== '' || category !== 'all';

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
      />

      <UserTable
        users={filtered}
        loading={loading}
        selectedIds={selectedIds}
        allSelected={allSelected}
        someSelected={someSelected}
        onToggle={handleToggleUser}
        onToggleAll={handleToggleAll}
        hasFilters={hasFilters}
        onClearFilters={handleClearFilters}
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
