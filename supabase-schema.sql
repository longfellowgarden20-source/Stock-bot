-- StockBot Schema
-- Run this in your Supabase SQL editor

-- Watchlist
create table if not exists watchlist (
  id uuid primary key default gen_random_uuid(),
  ticker text not null,
  name text,
  sector text,
  notes text,
  alert_threshold_pct numeric,
  added_at timestamptz default now()
);

-- Portfolio
create table if not exists portfolio (
  id uuid primary key default gen_random_uuid(),
  ticker text not null,
  shares numeric not null,
  avg_cost numeric not null,
  notes text,
  added_at timestamptz default now()
);

-- Signals — the core table
create table if not exists signals (
  id uuid primary key default gen_random_uuid(),
  ticker text not null,
  signal_type text not null,
  severity integer not null check (severity between 1 and 10),
  title text not null,
  body text not null,
  raw_data jsonb,
  read boolean default false,
  created_at timestamptz default now()
);
create index if not exists signals_ticker_idx on signals(ticker);
create index if not exists signals_created_at_idx on signals(created_at desc);
create index if not exists signals_severity_idx on signals(severity desc);

-- Snapshots — price/volume every 5 min during market hours
create table if not exists snapshots (
  id uuid primary key default gen_random_uuid(),
  ticker text not null,
  price numeric,
  volume bigint,
  change_pct numeric,
  market_cap bigint,
  short_interest numeric,
  iv_rank numeric,
  created_at timestamptz default now()
);
create index if not exists snapshots_ticker_idx on snapshots(ticker);
create index if not exists snapshots_created_at_idx on snapshots(created_at desc);

-- News
create table if not exists news (
  id uuid primary key default gen_random_uuid(),
  ticker text not null,
  headline text not null,
  source text,
  url text,
  sentiment text check (sentiment in ('bullish', 'bearish', 'neutral')),
  published_at timestamptz,
  created_at timestamptz default now()
);
create index if not exists news_ticker_idx on news(ticker);
create index if not exists news_created_at_idx on news(created_at desc);

-- Alerts
create table if not exists alerts (
  id uuid primary key default gen_random_uuid(),
  ticker text not null,
  condition text not null,
  threshold numeric,
  triggered_at timestamptz,
  notified boolean default false,
  created_at timestamptz default now()
);

-- Enable Realtime on signals table (run in Supabase dashboard or here)
-- alter publication supabase_realtime add table signals;
-- alter publication supabase_realtime add table snapshots;
