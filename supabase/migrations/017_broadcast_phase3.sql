-- ============================================================
-- Broadcast Phase 3: schedule + pause/resume/cancel + resend
--
--   1. Broadcast status machine grows 'paused' and 'cancelled'.
--      Existing statuses ('draft','scheduled','sending','sent',
--      'failed') are unchanged; the new set is a strict superset so
--      no existing row can violate the rebuilt CHECK.
--   2. broadcasts.header_image_url — the batch sender and, crucially,
--      the scheduled-send cron need the header image for
--      IMAGE-header templates. Today it is passed per batch request
--      from the composer; a server-dispatched scheduled send has no
--      composer, so it must ride on the row.
--   3. broadcasts.dispatch_mode — 'browser' broadcasts are pushed by
--      the composer hook / resume clicks; 'cron' broadcasts are sent
--      by the scheduled-send sweep. Exclusive ownership is what lets
--      the self-healing cron sweep re-queue half-sent scheduled
--      broadcasts without ever double-sending against an in-page
--      browser loop.
--   4. broadcasts.parent_broadcast_id + partial unique index — the
--      "Resend to Non-Responders" builds ONE new broadcast per source
--      broadcast. The index makes a double-click resolve to the same
--      new broadcast at the DB level (the API pre-checks too, but the
--      constraint is the backstop).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS header_image_url TEXT,
  ADD COLUMN IF NOT EXISTS dispatch_mode TEXT NOT NULL DEFAULT 'browser';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'broadcasts'::regclass
      AND conname = 'broadcasts_dispatch_mode_check'
  ) THEN
    ALTER TABLE broadcasts DROP CONSTRAINT broadcasts_dispatch_mode_check;
  END IF;
  ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_dispatch_mode_check
    CHECK (dispatch_mode IN ('browser', 'cron'));
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'broadcasts'::regclass
      AND conname = 'broadcasts_status_check'
  ) THEN
    ALTER TABLE broadcasts DROP CONSTRAINT broadcasts_status_check;
  END IF;
  ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_status_check
    CHECK (status IN (
      'draft', 'scheduled', 'sending', 'sent', 'failed',
      'paused', 'cancelled'
    ));
END $$;

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS parent_broadcast_id UUID REFERENCES broadcasts(id) ON DELETE SET NULL;

-- One resend per source broadcast, per user. Second insert raises
-- 23505, which the resend endpoint maps back to the existing row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_broadcasts_resend_once
  ON broadcasts (user_id, parent_broadcast_id)
  WHERE parent_broadcast_id IS NOT NULL;