-- ============================================================
-- 015 — Notification campaigns + recipients
-- ============================================================
-- Adds Broadcast-like reporting for push notifications.
-- Follows the same pattern as broadcasts (migration 001) and the
-- incremental aggregate trigger (migration 005), adapted for the
-- simpler FCM status model: sent / failed / skipped.
--
-- users.id is TEXT in this project (migration 014), so
-- notification_recipients.user_id must also be TEXT.
-- ============================================================

CREATE TABLE IF NOT EXISTS notification_campaigns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  image_url TEXT,
  target TEXT NOT NULL,
  category TEXT,
  total_targeted INTEGER DEFAULT 0,
  sent_count INTEGER DEFAULT 0,
  failed_count INTEGER DEFAULT 0,
  skipped_count INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notification_campaigns_created_at
  ON notification_campaigns (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_campaigns_status
  ON notification_campaigns (status);
CREATE INDEX IF NOT EXISTS idx_notification_campaigns_user_id
  ON notification_campaigns (user_id);

ALTER TABLE notification_campaigns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own notification campaigns" ON notification_campaigns;
CREATE POLICY "Users can manage own notification campaigns"
ON notification_campaigns
FOR ALL
USING (auth.uid() = user_id);

-- ============================================================

CREATE TABLE IF NOT EXISTS notification_recipients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  campaign_id UUID NOT NULL REFERENCES notification_campaigns(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  fcm_token TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  provider_message_id TEXT,
  error_code TEXT,
  error_message TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notification_recipients_campaign_id
  ON notification_recipients (campaign_id);
CREATE INDEX IF NOT EXISTS idx_notification_recipients_status
  ON notification_recipients (status);
CREATE INDEX IF NOT EXISTS idx_notification_recipients_user_id
  ON notification_recipients (user_id);

ALTER TABLE notification_recipients ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can manage own notification recipients" ON notification_recipients;
CREATE POLICY "Users can manage own notification recipients"
ON notification_recipients
FOR ALL
USING (EXISTS (
  SELECT 1 FROM notification_campaigns
  WHERE notification_campaigns.id = notification_recipients.campaign_id
    AND notification_campaigns.user_id = auth.uid()
));

-- ============================================================
-- Incremental aggregate trigger
-- ============================================================
-- Semantic model:
--   sent_count  = recipients with status 'sent'
--   failed_count = recipients with status 'failed'
--   skipped_count = recipients with status 'skipped'

CREATE OR REPLACE FUNCTION public._ncamp_bump(camp_id UUID, col TEXT, delta INT)
RETURNS VOID AS $$
BEGIN
  EXECUTE format(
    'UPDATE notification_campaigns SET %I = GREATEST(0, %I + $1), updated_at = NOW() WHERE id = $2',
    col, col
  ) USING delta, camp_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public._ncamp_cols_for_status(s TEXT)
RETURNS TEXT[] AS $$
BEGIN
  IF s = 'pending'  THEN RETURN ARRAY[]::TEXT[]; END IF;
  IF s = 'sent'     THEN RETURN ARRAY['sent_count']; END IF;
  IF s = 'failed'   THEN RETURN ARRAY['failed_count']; END IF;
  IF s = 'skipped'  THEN RETURN ARRAY['skipped_count']; END IF;
  RETURN ARRAY[]::TEXT[];
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.notification_recipient_aggregate_trigger()
RETURNS TRIGGER AS $$
DECLARE
  old_cols TEXT[];
  new_cols TEXT[];
  c TEXT;
  target_id UUID;
BEGIN
  IF TG_OP = 'INSERT' THEN
    target_id := NEW.campaign_id;
    new_cols := _ncamp_cols_for_status(NEW.status);
    FOREACH c IN ARRAY new_cols LOOP
      PERFORM _ncamp_bump(target_id, c, 1);
    END LOOP;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    target_id := OLD.campaign_id;
    old_cols := _ncamp_cols_for_status(OLD.status);
    FOREACH c IN ARRAY old_cols LOOP
      PERFORM _ncamp_bump(target_id, c, -1);
    END LOOP;
    RETURN OLD;
  END IF;

  -- UPDATE: only care if status changed.
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    target_id := NEW.campaign_id;
    old_cols := _ncamp_cols_for_status(OLD.status);
    new_cols := _ncamp_cols_for_status(NEW.status);
    FOREACH c IN ARRAY old_cols LOOP
      PERFORM _ncamp_bump(target_id, c, -1);
    END LOOP;
    FOREACH c IN ARRAY new_cols LOOP
      PERFORM _ncamp_bump(target_id, c, 1);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS notification_recipients_aggregate ON notification_recipients;
CREATE TRIGGER notification_recipients_aggregate
AFTER INSERT OR UPDATE OR DELETE ON notification_recipients
FOR EACH ROW EXECUTE FUNCTION public.notification_recipient_aggregate_trigger();

-- Safety net — rebuild counts from scratch.
CREATE OR REPLACE FUNCTION public.recompute_notification_campaign_counts(camp_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE notification_campaigns c SET
    sent_count   = agg.sent_count,
    failed_count = agg.failed_count,
    skipped_count = agg.skipped_count
  FROM (
    SELECT
      COUNT(*) FILTER (WHERE status = 'sent')   AS sent_count,
      COUNT(*) FILTER (WHERE status = 'failed')  AS failed_count,
      COUNT(*) FILTER (WHERE status = 'skipped') AS skipped_count
    FROM notification_recipients
    WHERE campaign_id = camp_id
  ) agg
  WHERE c.id = camp_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;
