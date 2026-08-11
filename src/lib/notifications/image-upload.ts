import { createClient } from '@/lib/supabase/client'

/**
 * Uploads a notification image to Supabase Storage and returns its public
 * URL. Reuses the existing `avatars` public bucket (the only configured
 * bucket) — its RLS INSERT policy lets an authenticated user write under
 * `{auth.uid()}/...`, so the `notification-images` subfolder is scoped to
 * the current user with no schema change. Throws on failure.
 */
export async function uploadNotificationImage(file: File, userId: string): Promise<string> {
  const supabase = createClient()

  const ext = file.name.split('.').pop()?.toLowerCase() || 'png'
  const path = `${userId}/notification-images/notification-${Date.now()}.${ext}`

  const { error } = await supabase.storage.from('avatars').upload(path, file, {
    cacheControl: '3600',
    upsert: false,
    contentType: file.type,
  })

  if (error) {
    throw new Error(`Image upload failed: ${error.message}`)
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from('avatars').getPublicUrl(path)

  return publicUrl
}
