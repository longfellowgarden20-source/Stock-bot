-- Migration v3: add columns referenced in code but missing from schema
-- Run this in Supabase SQL Editor

ALTER TABLE sandbox_trades
  ADD COLUMN IF NOT EXISTS peak_pnl_pct        numeric(8,4),
  ADD COLUMN IF NOT EXISTS profit_efficiency    numeric(8,4),
  ADD COLUMN IF NOT EXISTS stop_category        text,
  ADD COLUMN IF NOT EXISTS account_health       text,
  ADD COLUMN IF NOT EXISTS stop_distance_pct    numeric(8,4),
  ADD COLUMN IF NOT EXISTS conviction_label     text,
  ADD COLUMN IF NOT EXISTS is_convergence       boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS fill_status          text DEFAULT 'filled'; -- 'pending' | 'filled' | 'expired'

-- Back-fill existing trades as already filled
UPDATE sandbox_trades SET fill_status = 'filled' WHERE fill_status IS NULL;

-- Add rejected_candidates to premarket plans
ALTER TABLE sandbox_premarket_plans
  ADD COLUMN IF NOT EXISTS rejected_candidates jsonb DEFAULT '[]';

-- Ensure only one sandbox_account row ever exists
ALTER TABLE sandbox_account
  ADD COLUMN IF NOT EXISTS is_primary boolean DEFAULT true;

CREATE UNIQUE INDEX IF NOT EXISTS sandbox_account_single
  ON sandbox_account (is_primary) WHERE is_primary = true;
