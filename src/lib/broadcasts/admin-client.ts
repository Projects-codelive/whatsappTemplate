import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// Lazy, shared service-role client for broadcast Phase 3 work
// (action endpoints + scheduled-send cron). Mirrors the pattern used
// by the webhook handler (src/app/api/whatsapp/webhook/route.ts) and
// the automations/flows admin clients.
let _adminClient: SupabaseClient | null = null

export function supabaseAdmin(): SupabaseClient {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}