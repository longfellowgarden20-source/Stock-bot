-- Sandbox account — tracks the $50k starting balance
CREATE TABLE IF NOT EXISTS sandbox_account (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  balance       numeric(14,2) NOT NULL DEFAULT 50000.00,
  starting_balance numeric(14,2) NOT NULL DEFAULT 50000.00,
  peak_balance  numeric(14,2) NOT NULL DEFAULT 50000.00,
  total_trades  int DEFAULT 0,
  winning_trades int DEFAULT 0,
  losing_trades int DEFAULT 0,
  updated_at    timestamptz DEFAULT now()
);

-- Seed the account with $50k
INSERT INTO sandbox_account (balance, starting_balance, peak_balance)
VALUES (50000.00, 50000.00, 50000.00)
ON CONFLICT DO NOTHING;

-- Add dollar-based columns to sandbox_trades
ALTER TABLE sandbox_trades
  ADD COLUMN IF NOT EXISTS position_size    numeric(14,2),
  ADD COLUMN IF NOT EXISTS risk_amount      numeric(14,2),
  ADD COLUMN IF NOT EXISTS pnl_dollar_real  numeric(14,2),
  ADD COLUMN IF NOT EXISTS account_balance_at_entry numeric(14,2),
  ADD COLUMN IF NOT EXISTS confidence_used  int;

-- Equity snapshots — one row per day for the equity curve
CREATE TABLE IF NOT EXISTS sandbox_equity (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date        date NOT NULL UNIQUE,
  balance     numeric(14,2) NOT NULL,
  daily_pnl   numeric(14,2) DEFAULT 0,
  drawdown_pct numeric(8,4) DEFAULT 0,
  win_rate    numeric(5,2),
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sandbox_equity_date ON sandbox_equity(date DESC);
