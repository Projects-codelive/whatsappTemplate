'use client';

import { useEffect, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Broadcast, BroadcastRecipient } from '@/types';
import type { RealtimeChannel } from '@supabase/supabase-js';

interface RealtimeEvent<T> {
  eventType: 'INSERT' | 'UPDATE' | 'DELETE';
  new: T;
  old: Partial<T>;
}

interface UseBroadcastRealtimeOptions {
  /** Subscribe to broadcast_recipients changes for this broadcast. */
  broadcastId?: string;
  /** Subscribe to broadcasts row changes for this broadcast. */
  subscribeToBroadcast?: boolean;
  onBroadcastEvent?: (event: RealtimeEvent<Broadcast>) => void;
  onRecipientEvent?: (event: RealtimeEvent<BroadcastRecipient>) => void;
  enabled?: boolean;
}

/**
 * Broadcast-specific Realtime hook.
 *
 * - Subscribes to `broadcasts` row changes (INSERT/UPDATE/DELETE) when
 *   `subscribeToBroadcast` is true.
 * - Subscribes to `broadcast_recipients` changes filtered by
 *   `broadcast_id` when `broadcastId` is provided.
 *
 * Follows the same ref-callback pattern as `use-realtime.ts` to avoid
 * re-subscribing when the parent re-renders with fresh closures.
 */
export function useBroadcastRealtime({
  broadcastId,
  subscribeToBroadcast = false,
  onBroadcastEvent,
  onRecipientEvent,
  enabled = true,
}: UseBroadcastRealtimeOptions) {
  const channelRef = useRef<RealtimeChannel | null>(null);

  const onBroadcastRef = useRef(onBroadcastEvent);
  const onRecipientRef = useRef(onRecipientEvent);
  useEffect(() => {
    onBroadcastRef.current = onBroadcastEvent;
    onRecipientRef.current = onRecipientEvent;
  });

  useEffect(() => {
    if (!enabled) return;

    const supabase = createClient();
    const channels: RealtimeChannel[] = [];

    // Broadcasts row subscription — status/counter changes on the parent.
    if (subscribeToBroadcast) {
      const bcChannel = supabase
        .channel('broadcast-realtime')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'broadcasts' },
          (payload) => {
            onBroadcastRef.current?.({
              eventType: payload.eventType as RealtimeEvent<Broadcast>['eventType'],
              new: payload.new as Broadcast,
              old: payload.old as Partial<Broadcast>,
            });
          },
        )
        .subscribe();
      channels.push(bcChannel);
    }

    // Broadcast recipients subscription — scoped by broadcast_id via RLS.
    if (broadcastId) {
      const recChannel = supabase
        .channel(`broadcast-recipients:${broadcastId}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'broadcast_recipients',
            filter: `broadcast_id=eq.${broadcastId}`,
          },
          (payload) => {
            onRecipientRef.current?.({
              eventType: payload.eventType as RealtimeEvent<BroadcastRecipient>['eventType'],
              new: payload.new as BroadcastRecipient,
              old: payload.old as Partial<BroadcastRecipient>,
            });
          },
        )
        .subscribe();
      channels.push(recChannel);
    }

    channelRef.current = channels[0] ?? null;

    return () => {
      for (const ch of channels) supabase.removeChannel(ch);
      channelRef.current = null;
    };
  }, [broadcastId, subscribeToBroadcast, enabled]);
}
