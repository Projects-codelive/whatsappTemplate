'use client';

import { ChevronLeft, ChevronRight, Loader2, SearchX, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { PAGE_SIZE_OPTIONS } from '@/lib/notifications/user-list';
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

export interface UserTablePagination {
  page: number;
  pageSize: number;
  totalPages: number;
  startIndex: number;
  endIndex: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
}

interface UserTableProps {
  users: NotificationUser[];
  loading: boolean;
  /** Filtered-row count (not the current page) — drives the empty state. */
  totalFiltered: number;
  selectedIds: Set<string>;
  allSelected: boolean;
  someSelected: boolean;
  onToggle: (id: string, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
  hasFilters: boolean;
  onClearFilters: () => void;
  pagination: UserTablePagination;
}

export function UserTable({
  users,
  loading,
  totalFiltered,
  selectedIds,
  allSelected,
  someSelected,
  onToggle,
  onToggleAll,
  hasFilters,
  onClearFilters,
  pagination,
}: UserTableProps) {
  if (loading) {
    return (
      <div
        className="flex h-64 items-center justify-center gap-2 rounded-xl border border-slate-800 bg-slate-900"
        aria-live="polite"
      >
        <Loader2 className="size-6 animate-spin text-primary" />
        <span className="text-sm text-slate-400">Loading users...</span>
      </div>
    );
  }

  if (totalFiltered === 0) {
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

  const { page, pageSize, totalPages, startIndex, endIndex } = pagination;
  const canGoBack = page > 1;
  const canGoForward = page < totalPages;

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="border-slate-800 hover:bg-transparent">
              <TableHead className="w-10 text-slate-400">
                <Checkbox
                  checked={allSelected}
                  indeterminate={someSelected && !allSelected}
                  onCheckedChange={onToggleAll}
                  aria-label="Select all users on this page"
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

      <div className="flex flex-wrap items-center gap-2 border-t border-slate-800 px-4 py-3">
        <span className="text-xs text-slate-400">
          Showing {totalFiltered === 0 ? 0 : startIndex + 1}–{endIndex} of {totalFiltered}
        </span>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Select
            value={String(pageSize)}
            onValueChange={(val) => pagination.onPageSizeChange(Number(val))}
          >
            <SelectTrigger size="sm" className="w-fit bg-slate-800 text-slate-200">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="bg-slate-800 text-slate-200">
              {PAGE_SIZE_OPTIONS.map((size) => (
                <SelectItem key={size} value={String(size)} className="focus:bg-slate-700 focus:text-white">
                  {size} per page
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <span className="text-xs text-slate-400">
            Page {page} of {totalPages}
          </span>

          <Button
            variant="outline"
            size="icon"
            onClick={() => pagination.onPageChange(page - 1)}
            disabled={!canGoBack}
            aria-label="Previous page"
            className="border-slate-700 text-slate-300 hover:bg-slate-800"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={() => pagination.onPageChange(page + 1)}
            disabled={!canGoForward}
            aria-label="Next page"
            className="border-slate-700 text-slate-300 hover:bg-slate-800"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
