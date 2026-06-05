-- Sandbox trades table — Groq's paper trading account
CREATE TABLE IF NOT EXISTS sandbox_trades (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker          text NOT NULL,
  direction       text NOT NULL CHECK (direction IN ('long', 'short')),
  trade_type      text NOT NULL CHECK (trade_type IN ('day', 'swing')),
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  entry_price     numeric(12,4) NOT NULL,
  exit_price      numeric(12,4),
  stop_loss       numeric(12,4) NOT NULL,
  target_price    numeric(12,4) NOT NULL,
  shares          numeric(12,4) NOT NULL DEFAULT 100,
  entry_date      date NOT NULL,
  exit_date       date,
  pnl             numeric(12,2),
  pnl_pct         numeric(8,4),
  exit_reason     text,           -- 'target_hit', 'stop_hit', 'groq_exit', 'day_close', 'max_hold'
  groq_thesis     text,           -- why Groq entered
  groq_exit_note  text,           -- why Groq exited (if groq_exit)
  signals_at_entry jsonb,         -- snapshot of signals used to decide entry
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sandbox_trades_ticker ON sandbox_trades(ticker, entry_date DESC);
CREATE INDEX IF NOT EXISTS sandbox_trades_status ON sandbox_trades(status);
CREATE INDEX IF NOT EXISTS sandbox_trades_entry_date ON sandbox_trades(entry_date DESC);

-- Sandbox performance snapshots — daily summary for tracking 70% win rate goal
CREATE TABLE IF NOT EXISTS sandbox_performance (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date        date NOT NULL UNIQUE,
  trades_closed int DEFAULT 0,
  wins        int DEFAULT 0,
  losses      int DEFAULT 0,
  win_rate    numeric(5,2),
  gross_pnl   numeric(12,2) DEFAULT 0,
  created_at  timestamptz DEFAULT now()
);
