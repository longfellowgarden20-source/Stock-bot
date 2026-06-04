-- EOD price predictions table
-- Worker generates at open, actual_close filled after 4pm ET

CREATE TABLE IF NOT EXISTS eod_predictions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker        text NOT NULL,
  date          date NOT NULL,
  open_price    numeric(12,4),
  predicted_low  numeric(12,4),
  predicted_high numeric(12,4),
  bias          text,           -- 'bullish' | 'bearish' | 'neutral'
  confidence_pct int,
  key_factors   jsonb,          -- string[]
  invalidation_level numeric(12,4),
  analysis      text,
  actual_close  numeric(12,4),  -- filled at EOD
  error_pct     numeric(8,2),   -- (actual - open) / open * 100
  created_at    timestamptz DEFAULT now(),
  UNIQUE(ticker, date)
);

CREATE INDEX IF NOT EXISTS eod_predictions_ticker_date ON eod_predictions(ticker, date DESC);
