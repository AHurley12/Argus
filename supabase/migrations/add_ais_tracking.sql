-- ============================================================
-- Migration: add_ais_tracking.sql
-- ADDITIVE ONLY — never drops, renames, or modifies existing
-- columns, constraints, or behaviour on tracking_data.
--
-- SETUP STEPS:
--   1. Get free API key: https://aisstream.io
--      → Account → API Keys → Generate
--   2. supabase secrets set AISSTREAM_API_KEY=your_key_here
--   3. supabase functions deploy ingest-tracking
--   4. Run this file in Supabase SQL editor (Database → SQL Editor)
-- ============================================================

-- ── 0. Ensure base table exists (idempotent safety net) ─────────────────────
-- If tracking_data already exists this is a no-op.
CREATE TABLE IF NOT EXISTS public.tracking_data (
  id          bigserial PRIMARY KEY,
  lat         double precision,
  lon         double precision,
  heading     double precision,
  velocity    double precision,
  "timestamp" bigint,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

-- ── 1. Add AIS-specific columns (all nullable, additive only) ────────────────
ALTER TABLE public.tracking_data
  ADD COLUMN IF NOT EXISTS mmsi        text,
  ADD COLUMN IF NOT EXISTS ship_name   text,
  ADD COLUMN IF NOT EXISTS ship_type   text,
  ADD COLUMN IF NOT EXISTS flag        text,
  ADD COLUMN IF NOT EXISTS destination text,
  ADD COLUMN IF NOT EXISTS nav_status  text,
  ADD COLUMN IF NOT EXISTS source      text DEFAULT 'aisstream',
  ADD COLUMN IF NOT EXISTS raw         jsonb;

-- updated_at safety net (may already exist)
ALTER TABLE public.tracking_data
  ADD COLUMN IF NOT EXISTS updated_at  timestamptz DEFAULT now();

-- ── 2. Unique constraint on MMSI (required for ON CONFLICT upserts) ──────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'unique_mmsi'
      AND conrelid = 'public.tracking_data'::regclass
  ) THEN
    ALTER TABLE public.tracking_data
      ADD CONSTRAINT unique_mmsi UNIQUE (mmsi);
  END IF;
END$$;

-- ── 3. Indexes ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_tracking_mmsi
  ON public.tracking_data (mmsi);

CREATE INDEX IF NOT EXISTS idx_tracking_location
  ON public.tracking_data (lat, lon);

-- ── 4. Auto-prune: delete rows older than 30 minutes ─────────────────────────
-- Strategy A — pg_cron (available on Supabase paid plans):
--   Uncomment the block below if pg_cron is enabled on your project.
--   Go to Database → Extensions and search for "pg_cron" to check.
--
-- SELECT cron.schedule(
--   'prune-ais-tracking',            -- job name
--   '*/5 * * * *',                   -- every 5 minutes
--   $$DELETE FROM public.tracking_data
--       WHERE created_at < now() - interval '30 minutes'$$
-- );

-- Strategy B — delete-on-insert trigger (works on all plans, zero config).
-- Fires AFTER each INSERT batch; deletes stale rows before the new data
-- is visible to Realtime subscribers, keeping the table small (≤ 30 min window).
CREATE OR REPLACE FUNCTION public.prune_old_tracking_data()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM public.tracking_data
  WHERE created_at < now() - interval '30 minutes';
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_prune_tracking ON public.tracking_data;
CREATE TRIGGER trg_prune_tracking
  AFTER INSERT ON public.tracking_data
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.prune_old_tracking_data();

-- ── 5. Enable Realtime on tracking_data ──────────────────────────────────────
-- Supabase Realtime listens on supabase_realtime publication.
-- This is idempotent — adding an already-present table is a no-op.
DO $$
BEGIN
  -- Only run if the publication exists (it always does on Supabase hosted).
  IF EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) THEN
    -- pg_publication_tables lets us check membership first to avoid
    -- the "relation already exists in publication" error.
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname   = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename  = 'tracking_data'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.tracking_data;
    END IF;
  END IF;
END$$;
