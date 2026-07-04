-- Migration: bilateral_trade_cache
-- Caches UN Comtrade bilateral trade data.
-- TTL enforcement is handled in the application layer (7 days).

create table if not exists public.bilateral_trade_cache (
  id                bigserial primary key,
  reporter_iso3     text not null,
  partner_iso3      text not null,
  year              integer not null,
  flow_direction    text not null,       -- 'export' | 'import'
  commodity_code    text not null,       -- 'TOTAL' | HS2 code string
  trade_value_usd   numeric,
  quantity          numeric,
  quantity_unit     text,
  commodity_desc    text,
  payload           jsonb,
  fetched_at        timestamptz not null default now()
);

create unique index if not exists bilateral_trade_cache_uniq
  on public.bilateral_trade_cache (reporter_iso3, partner_iso3, year, flow_direction, commodity_code);

create index if not exists bilateral_trade_cache_lookup
  on public.bilateral_trade_cache (reporter_iso3, partner_iso3, year);

alter table public.bilateral_trade_cache enable row level security;

create policy "Public read bilateral trade cache"
  on public.bilateral_trade_cache for select
  using (true);

comment on table public.bilateral_trade_cache is
  'Cache for UN Comtrade bilateral trade data. TTL enforced in application layer (7 days).';
