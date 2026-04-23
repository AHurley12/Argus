-- ── Argus Deduplication Schema ──────────────────────────────────────────────
-- Run ONCE in the Supabase SQL editor.
-- Safe to re-run — all statements are idempotent.


-- ── 1. Enable pg_trgm ────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_trgm;


-- ── 2. One-time purge of existing pending duplicates ─────────────────────────
-- For rows in 'pending' status, keep only the earliest created_at per fuzzy
-- title cluster (similarity > 0.85). Deletes the rest.
--
-- Strategy:
--   a) Self-join all pending pairs where similarity > 0.85
--   b) Assign each row to its earliest-created_at cluster representative
--   c) Delete rows that are NOT the cluster representative
--
-- Note: This is a one-shot cleanup. Going forward, the unique index below
-- blocks exact dupes and is_duplicate_event() blocks fuzzy dupes at ingest.

WITH pending AS (
  SELECT id, data->>'title' AS title, created_at
  FROM   argus_event_queue
  WHERE  status = 'pending'
    AND  data->>'title' IS NOT NULL
),
pairs AS (
  -- All pending pairs whose titles are ≥ 85% similar (directional, both orders)
  SELECT
    a.id                                                 AS id,
    MIN(b.id) OVER (PARTITION BY a.id ORDER BY b.created_at, b.id)  AS canonical_id,
    a.created_at,
    MIN(b.created_at) OVER (PARTITION BY a.id)          AS canonical_created_at
  FROM pending a
  JOIN pending b ON a.id <> b.id
               AND similarity(a.title, b.title) > 0.85
),
-- For each row, find whether a strictly earlier similar row exists
newer_dupes AS (
  SELECT DISTINCT p.id
  FROM   pairs p
  WHERE  p.canonical_created_at < p.created_at
      OR (p.canonical_created_at = p.created_at AND p.canonical_id < p.id)
)
DELETE FROM argus_event_queue
WHERE  id IN (SELECT id FROM newer_dupes)
  AND  status = 'pending';


-- ── 3. Partial unique index — block exact-title dupes for pending rows ────────
-- Prevents two pending rows with identical data->>'title' values.
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_pending_title
  ON argus_event_queue ((data->>'title'))
  WHERE status = 'pending';


-- ── 4. GIN trigram index — fast fuzzy lookups on pending titles ───────────────
CREATE INDEX IF NOT EXISTS idx_trgm_event_title
  ON argus_event_queue
  USING gin ((data->>'title') gin_trgm_ops);


-- ── 5. is_duplicate_event() — fuzzy dupe gate for ingestion ──────────────────
-- Returns TRUE if any pending or approved event exists where:
--   • similarity(title, p_title) > 0.82
--   • category matches p_category (case-insensitive)
--   • created_at is within the last 72 hours
--
-- Called from the frontend before every AUTO_SUGGEST INSERT.
-- Silently returns FALSE on error (fail-open for ingestion).
CREATE OR REPLACE FUNCTION is_duplicate_event(
  p_title    text,
  p_category text
)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM   argus_event_queue
    WHERE  status IN ('pending', 'approved')
      AND  LOWER(category) = LOWER(p_category)
      AND  created_at >= NOW() - INTERVAL '72 hours'
      AND  similarity(data->>'title', p_title) > 0.82
  );
$$;
