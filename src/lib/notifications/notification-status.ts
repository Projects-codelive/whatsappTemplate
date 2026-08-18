/**
 * Shared status badge config for notification campaigns + recipients.
 *
 * Follows the same pattern as lib/broadcast-status.ts.
 * Dark-theme only — bg-*-500/10 + text-*-400 + border-*-500/20.
 */

import type {
  NotificationCampaignStatus,
  NotificationRecipientStatus,
} from './campaign'

export interface StatusDisplay {
  label: string
  classes: string
  pulse?: boolean
}

export const campaignStatusConfig: Record<NotificationCampaignStatus, StatusDisplay> = {
  sending: {
    label: 'Sending',
    classes: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
    pulse: true,
  },
  sent: {
    label: 'Sent',
    classes: 'bg-primary/10 text-primary border-primary/20',
  },
  failed: {
    label: 'Failed',
    classes: 'bg-red-500/10 text-red-400 border-red-500/20',
  },
}

export const notificationRecipientStatusConfig: Record<
  NotificationRecipientStatus,
  StatusDisplay
> = {
  pending: {
    label: 'Pending',
    classes: 'bg-slate-500/10 text-slate-400 border-slate-500/20',
  },
  sent: {
    label: 'Sent',
    classes: 'bg-primary/10 text-primary border-primary/20',
  },
  failed: {
    label: 'Failed',
    classes: 'bg-red-500/10 text-red-400 border-red-500/20',
  },
  skipped: {
    label: 'Skipped',
    classes: 'bg-amber-500/10 text-amber-400 border-amber-500/20',
  },
}

export function getCampaignStatus(status: string): StatusDisplay {
  return (
    campaignStatusConfig[status as NotificationCampaignStatus] ??
    campaignStatusConfig.sending
  )
}

export function getNotificationRecipientStatus(status: string): StatusDisplay {
  return (
    notificationRecipientStatusConfig[status as NotificationRecipientStatus] ??
    notificationRecipientStatusConfig.pending
  )
}
