-- Partial exit tracking for #11
ALTER TABLE sandbox_trades
  ADD COLUMN IF NOT EXISTS target1          numeric(12,4),
  ADD COLUMN IF NOT EXISTS partial_exit_done boolean DEFAULT false;
