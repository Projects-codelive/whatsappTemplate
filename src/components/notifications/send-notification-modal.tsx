'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ImagePlus, Loader2, Trash2 } from 'lucide-react';
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
import { useAuth } from '@/hooks/use-auth';
import type { NotificationPayload, NotificationTarget } from '@/types';
import { NOTIFICATION_CATEGORIES } from '@/lib/notifications/categories';
import { describeSendTarget } from '@/lib/notifications/user-list';
import { getRecipientCount } from '@/lib/notifications/recipient-count';
import { validateNotificationImage } from '@/lib/notifications/notification-image';
import { uploadNotificationImage } from '@/lib/notifications/image-upload';

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
  const { user } = useAuth();
  const [target, setTarget] = useState<NotificationTarget>('selected');
  const [category, setCategory] = useState('');
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);

  const [imageFile, setImageFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [count, setCount] = useState<number | null>(null);
  const [countLoading, setCountLoading] = useState(false);
  const [countError, setCountError] = useState(false);

  // Revoke the preview object URL when it is replaced or the modal unmounts.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  // Fetch the server-side recipient count for the current target. The
  // endpoint resolves exactly the same scope as the send route, so the
  // number shown always matches the set that will actually be sent. Runs
  // only while the modal is open, and refetches whenever the target,
  // category, or selection changes.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    async function loadCount() {
      if (target === 'selected' && selectedUserIds.length === 0) {
        setCount(0);
        setCountError(false);
        setCountLoading(false);
        return;
      }
      if (target === 'category' && !category) {
        setCount(null);
        setCountError(false);
        setCountLoading(false);
        return;
      }

      setCountLoading(true);
      setCountError(false);
      try {
        const result = await getRecipientCount(
          target === 'selected'
            ? { target: 'selected', userIds: selectedUserIds }
            : target === 'all'
              ? { target: 'all' }
              : { target: 'category', category },
        );
        if (!cancelled) {
          setCount(result);
        }
      } catch {
        if (!cancelled) setCountError(true);
      } finally {
        if (!cancelled) setCountLoading(false);
      }
    }

    void loadCount();

    return () => {
      cancelled = true;
    };
  }, [open, target, category, selectedUserIds]);

  function handleTargetChange(value: NotificationTarget) {
    setTarget(value);
    if (value === 'category' && !category && NOTIFICATION_CATEGORIES.length > 0) {
      setCategory(NOTIFICATION_CATEGORIES[0]);
    }
  }

  function handlePickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // reset so the same file can be re-picked
    if (!file) return;

    const validation = validateNotificationImage(file);
    if (!validation.ok) {
      toast.error('Invalid image', { description: validation.error });
      return;
    }

    setImageFile(file);
    setPreviewUrl(URL.createObjectURL(file));
  }

  function handleRemoveImage() {
    setImageFile(null);
    setPreviewUrl(null);
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
      let imageUrl: string | undefined;
      if (imageFile) {
        if (!user) {
          toast.error('You must be signed in to upload an image');
          return;
        }
        try {
          imageUrl = await uploadNotificationImage(imageFile, user.id);
        } catch (uploadError) {
          toast.error(
            uploadError instanceof Error
              ? uploadError.message
              : 'Image upload failed',
          );
          return;
        }
      }

      await onSend(imageUrl ? { ...payload, imageUrl } : payload);
      setTitle('');
      setMessage('');
      setTarget('selected');
      setCategory('');
      setImageFile(null);
      setPreviewUrl(null);
      onOpenChange(false);
    } catch {
      // Keep the modal open — the page already toasted the error.
    } finally {
      setSending(false);
    }
  }

  const confirmation = describeSendTarget({
    target,
    selectedCount: selectedUserIds.length,
    category: target === 'category' ? category : null,
  });

  const countText =
    count !== null
      ? `Recipients: ${count} user${count === 1 ? '' : 's'}`
      : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col overflow-hidden bg-slate-900 border-slate-700 sm:max-w-lg">
        <DialogHeader className="shrink-0">
          <DialogTitle className="text-white">Send Notification</DialogTitle>
          <DialogDescription className="text-slate-400">
            Choose who receives this push notification.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto py-2 pr-1">
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
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <p className="text-xs text-slate-400">{confirmation}</p>
              {countLoading ? (
                <p className="text-xs text-slate-400" aria-live="polite">
                  Recipients: Calculating...
                </p>
              ) : countError ? (
                <p className="text-xs text-amber-400" aria-live="polite">
                  Recipients: unavailable
                </p>
              ) : (
                countText && (
                  <p className="text-xs font-medium text-slate-300" aria-live="polite">
                    {countText}
                  </p>
                )
              )}
            </div>
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

          <div className="space-y-2">
            <Label className="text-slate-300">Image (Optional)</Label>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              onChange={handlePickImage}
            />
            {previewUrl && imageFile ? (
              <div className="flex items-start gap-3 rounded-lg border border-slate-700 bg-slate-800/50 p-3">
                <img
                  src={previewUrl}
                  alt="Notification image preview"
                  className="h-20 w-20 shrink-0 rounded-md object-cover"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-slate-300">{imageFile.name}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={sending}
                      className="border-slate-700 text-slate-300 hover:bg-slate-800"
                    >
                      Replace
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={handleRemoveImage}
                      disabled={sending}
                      className="text-slate-400 hover:text-white"
                    >
                      <Trash2 className="size-4" />
                      Remove
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={sending}
                className="border-slate-700 text-slate-300 hover:bg-slate-800"
              >
                <ImagePlus className="size-4" />
                Choose image
              </Button>
            )}
            <p className="text-xs text-slate-500">
              PNG, JPG, or WebP. Up to 2 MB.
            </p>
          </div>

          <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-3">
            <p className="text-xs font-medium tracking-wide text-slate-400 uppercase">
              Preview
            </p>
            <p className="mt-1 text-sm font-semibold text-white">
              {title.trim() || <span className="font-normal text-slate-500 italic">Notification title</span>}
            </p>
            <p className="mt-0.5 text-sm text-slate-300">
              {message.trim() || <span className="italic text-slate-500">Notification message preview.</span>}
            </p>
            {previewUrl && (
              <img
                src={previewUrl}
                alt=""
                className="mt-2 max-h-24 w-full rounded-md object-cover"
              />
            )}
          </div>

          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>Title: {title.length} characters</span>
            <span>Message: {message.length} characters</span>
          </div>
        </div>

        <DialogFooter className="shrink-0 bg-slate-900 border-slate-700">
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
              'Send Notification'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
