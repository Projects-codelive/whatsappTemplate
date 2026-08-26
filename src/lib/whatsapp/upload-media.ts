import { createClient } from '@/lib/supabase/client';

/**
 * Uploads an image file to Supabase Storage and returns its public URL.
 *
 * The returned URL is passed directly to Meta's Cloud API as the image
 * link in the template header component. Meta fetches the image from
 * this URL at send time, so the bucket MUST be set to public in your
 * Supabase dashboard (Storage → your bucket → Make public).
 *
 * Supported formats: JPEG, PNG (Meta's accepted image types for templates).
 * Max size: 5MB (Meta's limit for template header images).
 */
export async function uploadImageToStorage(file: File): Promise<string> {
  const supabase = createClient();

  // Validate file type before uploading
  if (!['image/jpeg', 'image/png'].includes(file.type)) {
    throw new Error('Only JPEG and PNG images are supported.');
  }

  // Validate file size (5MB Meta limit)
  const MAX_SIZE_MB = 5;
  if (file.size > MAX_SIZE_MB * 1024 * 1024) {
    throw new Error(`Image must be under ${MAX_SIZE_MB}MB.`);
  }

  const ext = file.type === 'image/png' ? 'png' : 'jpg';
  const fileName = `broadcast-images/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

  const { error } = await supabase.storage
    .from('broadcast-media')  // ✅ updated
    .upload(fileName, file, {
      contentType: file.type,
      upsert: false,
    });

  if (error) throw new Error(`Image upload failed: ${error.message}`);

  const { data } = supabase.storage
    .from('broadcast-media')  // ✅ updated
    .getPublicUrl(fileName);

  if (!data.publicUrl) {
    throw new Error('Failed to get public URL for uploaded image.');
  }

  return data.publicUrl;
}