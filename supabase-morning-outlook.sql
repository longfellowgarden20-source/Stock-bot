CREATE TABLE IF NOT EXISTS market_outlooks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  date        date NOT NULL UNIQUE,
  direction   text NOT NULL CHECK (direction IN ('bullish', 'bearish', 'neutral')),
  analysis    text,
  spy_change  numeric(8,4),
  qqq_change  numeric(8,4),
  vix         numeric(8,4),
  ten_y       numeric(8,4),
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS market_outlooks_date ON market_outlooks(date DESC);
