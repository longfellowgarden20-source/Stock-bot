create table if not exists trades (
  id uuid primary key default gen_random_uuid(),
  date date not null,
  ticker text not null,
  direction text not null check (direction in ('long', 'short')),
  entry_price numeric(12,4) not null,
  exit_price numeric(12,4),
  shares numeric(12,2) not null,
  pnl numeric(12,2),
  pattern text,
  grade text check (grade in ('A+', 'A', 'A-', 'B+', 'B', 'B-', 'C', 'D', 'F')),
  grade_accurate boolean,
  writeup text,
  mistakes text[],
  best_ops text,
  created_at timestamptz default now()
);

create table if not exists journal_entries (
  id uuid primary key default gen_random_uuid(),
  date date not null unique,
  mood text check (mood in ('focused', 'distracted', 'confident', 'anxious', 'neutral')),
  market_notes text,
  best_trade_id uuid references trades(id),
  worst_trade_id uuid references trades(id),
  lessons text,
  created_at timestamptz default now()
);

create table if not exists coaching_notes (
  id uuid primary key default gen_random_uuid(),
  generated_at timestamptz default now(),
  period text not null,
  note text not null,
  tendencies jsonb,
  trade_count int,
  win_rate numeric(5,2)
);
