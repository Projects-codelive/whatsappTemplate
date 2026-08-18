-- ============================================================
-- 016 — notification_recipients: add failed_at timestamp
-- ============================================================
-- Records exactly when an FCM send attempt failed for a recipient,
-- enabling time-based reporting (e.g. "how long did the campaign
-- take to process failures?").
-- ============================================================

ALTER TABLE notification_recipients
  ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;
