'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  RadioGroup,
  RadioGroupItem,
} from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { NotificationPayload, NotificationTarget } from '@/types';
import { NOTIFICATION_CATEGORIES } from '@/lib/notifications/categories';

const TARGET_OPTIONS: { value: NotificationTarget; label: string }[] = [
  { value: 'selected', label: 'Selected Users' },
  { value: 'all', label: 'All Users' },
  { value: 'category', label: 'Category' },
];

interface SendNotificationModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedUserIds: string[];
  onSend: (payload: NotificationPayload) => Promise<void>;
}

export function SendNotificationModal({
  open,
  onOpenChange,
  selectedUserIds,
  onSend,
}: SendNotificationModalProps) {
  const [target, setTarget] = useState<NotificationTarget>('selected');
  const [category, setCategory] = useState('');
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  function handleTargetChange(value: NotificationTarget) {
    setTarget(value);
    if (value === 'category' && !category && NOTIFICATION_CATEGORIES.length > 0) {
      setCategory(NOTIFICATION_CATEGORIES[0]);
    }
  }

  async function handleSend() {
    if (!title.trim()) {
      toast.error('Notification title is required');
      return;
    }
    if (!message.trim()) {
      toast.error('Notification message is required');
      return;
    }

    let payload: NotificationPayload;
    if (target === 'selected') {
      if (selectedUserIds.length === 0) {
        toast.error('Select at least one user');
        return;
      }
      payload = {
        target: 'selected',
        userIds: selectedUserIds,
        title: title.trim(),
        message: message.trim(),
      };
    } else if (target === 'all') {
      payload = {
        target: 'all',
        title: title.trim(),
        message: message.trim(),
      };
    } else {
      if (!category) {
        toast.error('Select a category');
        return;
      }
      payload = {
        target: 'category',
        category,
        title: title.trim(),
        message: message.trim(),
      };
    }

    setSending(true);
    try {
      await onSend(payload);
      setTitle('');
      setMessage('');
      setTarget('selected');
      setCategory('');
      onOpenChange(false);
    } catch {
      // Keep the modal open — the page already toasted the error.
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-slate-900 border-slate-700 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-white">Send Notification</DialogTitle>
          <DialogDescription className="text-slate-400">
            Choose who receives this push notification.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label className="text-slate-300">Notification Target</Label>
            <RadioGroup
              value={target}
              onValueChange={(val) => handleTargetChange(val as NotificationTarget)}
              className="gap-2"
            >
              {TARGET_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className="flex cursor-pointer items-center gap-2 text-sm text-slate-300"
                >
                  <RadioGroupItem value={option.value} />
                  {option.label}
                </label>
              ))}
            </RadioGroup>
          </div>

          {target === 'category' && (
            <div className="space-y-2">
              <Label className="text-slate-300">Category</Label>
              {NOTIFICATION_CATEGORIES.length > 0 ? (
                <Select value={category} onValueChange={(val) => setCategory(val ?? '')}>
                  <SelectTrigger className="w-full bg-slate-800 border-slate-700 text-white">
                    <SelectValue placeholder="Select a category" />
                  </SelectTrigger>
                  <SelectContent className="bg-slate-800 border-slate-700">
                    {NOTIFICATION_CATEGORIES.map((cat) => (
                      <SelectItem
                        key={cat}
                        value={cat}
                        className="text-white focus:bg-slate-700 focus:text-white"
                      >
                        {cat}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-xs text-slate-500">No categories available.</p>
              )}
            </div>
          )}

          <div className="space-y-2">
            <Label className="text-slate-300">Notification Title</Label>
            <Input
              placeholder="e.g. New course announcement"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500"
            />
          </div>

          <div className="space-y-2">
            <Label className="text-slate-300">Notification Message</Label>
            <Textarea
              placeholder="Enter your notification message."
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 resize-none"
            />
          </div>
        </div>

        <DialogFooter className="bg-slate-900 border-slate-700">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={sending}
            className="border-slate-700 text-slate-300 hover:bg-slate-800"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSend}
            disabled={sending}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {sending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Sending...
              </>
            ) : (
              'Send'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
