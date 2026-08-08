'use client';

import { RefreshCw, Search, Send, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { NOTIFICATION_CATEGORIES } from '@/lib/notifications/categories';

interface UserToolbarProps {
  search: string;
  onSearchChange: (value: string) => void;
  category: string;
  onCategoryChange: (value: string) => void;
  syncing: boolean;
  onSyncClick: () => void;
  onSendClick: () => void;
  totalCount: number;
  filteredCount: number;
  selectedCount: number;
  hasActiveFilters: boolean;
  onClearFilters: () => void;
}

export function UserToolbar({
  search,
  onSearchChange,
  category,
  onCategoryChange,
  syncing,
  onSyncClick,
  onSendClick,
  totalCount,
  filteredCount,
  selectedCount,
  hasActiveFilters,
  onClearFilters,
}: UserToolbarProps) {
  const searchActive = search.trim() !== '';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-0 flex-1 basis-64">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-500" />
        <Input
          type="search"
          placeholder="Search user by name, mobile, or email..."
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          className={`bg-slate-900 text-white placeholder:text-slate-500 ${searchActive ? 'pr-8' : ''}`}
        />
        {searchActive && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => onSearchChange('')}
            aria-label="Clear search"
            className="absolute top-1/2 right-1.5 -translate-y-1/2 text-slate-400 hover:text-white"
          >
            <X className="size-3.5" />
          </Button>
        )}
      </div>

      <span className="text-xs text-slate-500" aria-live="polite">
        {hasActiveFilters
          ? `${filteredCount} of ${totalCount} user${totalCount === 1 ? '' : 's'}`
          : `${totalCount} user${totalCount === 1 ? '' : 's'}`}
      </span>

      <Select value={category} onValueChange={(val) => onCategoryChange(val ?? 'all')}>
        <SelectTrigger className="w-fit bg-slate-900 text-slate-200">
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="bg-slate-900 text-slate-200">
          <SelectItem value="all" className="focus:bg-slate-800 focus:text-white">
            All
          </SelectItem>
          {NOTIFICATION_CATEGORIES.map((cat) => (
            <SelectItem key={cat} value={cat} className="focus:bg-slate-800 focus:text-white">
              {cat}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {hasActiveFilters && (
        <Button
          variant="outline"
          onClick={onClearFilters}
          className="border-slate-700 text-slate-300 hover:bg-slate-800"
        >
          <X className="size-4" />
          Clear filters
        </Button>
      )}

      <Button
        variant="outline"
        onClick={onSyncClick}
        disabled={syncing}
        className="border-slate-700 text-slate-300 hover:bg-slate-800"
      >
        <RefreshCw className={`size-4 ${syncing ? 'animate-spin' : ''}`} />
        {syncing ? 'Syncing users...' : 'Sync Users'}
      </Button>

      <Button
        onClick={onSendClick}
        disabled={syncing}
        className="bg-primary text-primary-foreground hover:bg-primary/90"
      >
        <Send className="size-4" />
        Send Notification
        {selectedCount > 0 && <span className="ml-1 rounded-full bg-white/20 px-1.5 text-xs">{selectedCount}</span>}
      </Button>
    </div>
  );
}
