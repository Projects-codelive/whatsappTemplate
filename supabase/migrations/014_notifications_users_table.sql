-- ============================================================
-- 014 — Notifications user management table
-- ============================================================
-- Replaces the previous `users` table (migration 013) with the
-- shape required by the Notifications page. Users are imported
-- from the Niveshbay Users API and stored locally so the page
-- reads ONLY from Supabase.
--
-- The previous table was tied to auth.users via a user_id FK and
-- is unused by any application code, so it is dropped and recreated
-- to match the API payload columns exactly. Synchronization is
-- idempotent keyed on `id` (the upstream user id).
-- ============================================================

DROP TABLE IF EXISTS public.users CASCADE;

CREATE TABLE public.users (
  id TEXT PRIMARY KEY,
  name TEXT,
  mobile TEXT,
  email TEXT,
  category TEXT,
  fcm_token TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  joined_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_mobile ON public.users(mobile);
CREATE INDEX IF NOT EXISTS idx_users_email ON public.users(email);
CREATE INDEX IF NOT EXISTS idx_users_category ON public.users(category);
CREATE INDEX IF NOT EXISTS idx_users_name ON public.users(name);

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage own users" ON public.users;

CREATE POLICY "Users can manage own users"
ON public.users
FOR ALL
USING (auth.uid() IS NOT NULL)
WITH CHECK (auth.uid() IS NOT NULL);
