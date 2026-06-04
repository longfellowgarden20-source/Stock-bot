-- Dead-Letter Queue for failed signal inserts
create table if not exists failed_signals (
  id uuid primary key default gen_random_uuid(),
  ticker text,
  signal_type text,
  severity int,
  title text,
  body text,
  raw_data jsonb,
  error_message text,
  retry_count int default 0,
  created_at timestamptz default now(),
  last_retry_at timestamptz,
  resolved boolean default false
);

-- Index for efficient querying of unresolved retryable rows
create index if not exists failed_signals_unresolved_idx
  on failed_signals (resolved, retry_count, created_at)
  where resolved = false;
