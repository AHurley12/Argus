-- ── Argus Usage Limiting Schema ──────────────────────────────────────────────
-- Run this in the Supabase SQL editor ONCE before deploying ai-query.js
-- and ai-classify.js.
--
-- Tables:
--   system_usage    — global query counter + running cost (ai-query.js)
--   usage_tracking  — per-user rate limiting (ai-query.js)
--   classify_usage  — daily batch counter for background classification (ai-classify.js)


-- ── system_usage: single-row global counter ───────────────────────────────────
create table if not exists system_usage (
  id            integer primary key default 1,  -- always 1, enforced below
  total_queries integer not null default 0,
  total_cost    numeric(10, 4) not null default 0,
  updated_at    timestamptz not null default now()
);

-- Seed the one required row (idempotent)
insert into system_usage (id, total_queries, total_cost)
values (1, 0, 0.0)
on conflict (id) do nothing;

-- Prevent extra rows — this must always be exactly one row
create unique index if not exists system_usage_single_row on system_usage (id);


-- ── usage_tracking: per-user rate limiting ────────────────────────────────────
-- user_id is the ArgusUID generated in the browser (localStorage UUID).
-- Not auth-linked yet — extend with a FK to auth.users when auth is added.
create table if not exists usage_tracking (
  user_id                 text primary key,
  query_count             integer not null default 0,     -- lifetime total
  last_query_timestamp    bigint  not null default 0,     -- epoch ms
  hourly_query_count      integer not null default 0,
  hourly_reset_timestamp  bigint  not null default 0,     -- epoch ms of last hour reset
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- Row-level security: service key bypasses RLS; anon key has no access
alter table usage_tracking enable row level security;

-- No public policies — only the service role (Netlify function) may read/write
-- (RLS with no policies = deny all for non-service roles)


-- ── classify_usage: daily batch cap for background AI classification ──────────
create table if not exists classify_usage (
  date        text primary key,   -- "YYYY-MM-DD" UTC
  batch_count integer not null default 0,
  updated_at  timestamptz not null default now()
);

-- Automatically purge entries older than 7 days (optional, keeps table tidy)
-- Enable pg_cron in Supabase dashboard and uncomment:
-- select cron.schedule('cleanup-classify-usage', '0 2 * * *',
--   $$delete from classify_usage where date < (current_date - interval '7 days')::text$$);
