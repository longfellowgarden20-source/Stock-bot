-- Migration v3: add columns referenced in code but missing from schema
-- Run this in Supabase SQL Editor

ALTER TABLE sandbox_trades
  ADD COLUMN IF NOT EXISTS peak_pnl_pct        numeric(8,4),
  ADD COLUMN IF NOT EXISTS profit_efficiency    numeric(8,4),
  ADD COLUMN IF NOT EXISTS stop_category        text,
  ADD COLUMN IF NOT EXISTS account_health       text,
  ADD COLUMN IF NOT EXISTS stop_distance_pct    numeric(8,4),
  ADD COLUMN IF NOT EXISTS conviction_label     text,
  ADD COLUMN IF NOT EXISTS is_convergence       boolean DEFAULT false;

-- Ensure only one sandbox_account row ever exists
ALTER TABLE sandbox_account
  ADD COLUMN IF NOT EXISTS is_primary boolean DEFAULT true;

CREATE UNIQUE INDEX IF NOT EXISTS sandbox_account_single
  ON sandbox_account (is_primary) WHERE is_primary = true;
