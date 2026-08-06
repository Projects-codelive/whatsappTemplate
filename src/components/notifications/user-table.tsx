'use client';

import { Loader2, SearchX, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { NotificationUser } from '@/types';

function formatDate(value: string | null): string {
  if (!value) return '-';
  return new Date(value).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

interface UserRowProps {
  user: NotificationUser;
  selected: boolean;
  onToggle: (checked: boolean) => void;
}

export function UserRow({ user, selected, onToggle }: UserRowProps) {
  return (
    <TableRow className="border-slate-800 hover:bg-slate-800/50">
      <TableCell>
        <Checkbox
          checked={selected}
          onCheckedChange={onToggle}
          aria-label={`Select ${user.name ?? user.id}`}
        />
      </TableCell>
      <TableCell className="font-medium text-white">
        {user.name || <span className="text-slate-500 italic">Unknown</span>}
      </TableCell>
      <TableCell className="font-mono text-xs text-slate-300">
        {user.mobile || <span className="text-slate-600">-</span>}
      </TableCell>
      <TableCell className="hidden text-sm text-slate-400 md:table-cell">
        {user.email || <span className="text-slate-600">-</span>}
      </TableCell>
      <TableCell className="hidden text-slate-300 sm:table-cell">
        {user.category || <span className="text-slate-600">-</span>}
      </TableCell>
      <TableCell className="hidden text-xs text-slate-500 lg:table-cell">
        {formatDate(user.joined_at)}
      </TableCell>
      <TableCell className="hidden text-xs text-slate-500 lg:table-cell">
        {formatDate(user.created_at)}
      </TableCell>
    </TableRow>
  );
}

interface UserTableProps {
  users: NotificationUser[];
  loading: boolean;
  selectedIds: Set<string>;
  allSelected: boolean;
  someSelected: boolean;
  onToggle: (id: string, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
  hasFilters: boolean;
  onClearFilters: () => void;
}

export function UserTable({
  users,
  loading,
  selectedIds,
  allSelected,
  someSelected,
  onToggle,
  onToggleAll,
  hasFilters,
  onClearFilters,
}: UserTableProps) {
  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl border border-slate-800 bg-slate-900">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  if (users.length === 0) {
    return (
      <div className="flex h-64 flex-col items-center justify-center rounded-xl border border-slate-800 bg-slate-900">
        {hasFilters ? (
          <>
            <SearchX className="mb-3 size-10 text-slate-600" />
            <p className="text-sm font-medium text-white">No users found.</p>
            <p className="mt-1 text-xs text-slate-400">
              Try adjusting your search or category filter.
            </p>
            <Button
              variant="outline"
              onClick={onClearFilters}
              className="mt-4 border-slate-700 text-slate-300 hover:bg-slate-800"
            >
              Clear filters
            </Button>
          </>
        ) : (
          <>
            <Users className="mb-3 size-10 text-slate-600" />
            <p className="text-sm font-medium text-white">No users found.</p>
            <p className="mt-1 text-xs text-slate-400">
              Use the Sync Users button to import users from the API.
            </p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900">
      <Table>
        <TableHeader>
          <TableRow className="border-slate-800 hover:bg-transparent">
            <TableHead className="w-10 text-slate-400">
              <Checkbox
                checked={allSelected}
                indeterminate={someSelected && !allSelected}
                onCheckedChange={onToggleAll}
                aria-label="Select all users"
              />
            </TableHead>
            <TableHead className="text-slate-400">Name</TableHead>
            <TableHead className="text-slate-400">Mobile</TableHead>
            <TableHead className="hidden text-slate-400 md:table-cell">Email</TableHead>
            <TableHead className="hidden text-slate-400 sm:table-cell">Category</TableHead>
            <TableHead className="hidden text-slate-400 lg:table-cell">Joined Date</TableHead>
            <TableHead className="hidden text-slate-400 lg:table-cell">Created Date</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.map((user) => (
            <UserRow
              key={user.id}
              user={user}
              selected={selectedIds.has(user.id)}
              onToggle={(checked) => onToggle(user.id, checked)}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
