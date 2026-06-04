-- Prediction lessons table — Groq learns from its mistakes
CREATE TABLE IF NOT EXISTS prediction_lessons (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticker        text NOT NULL,
  date          date NOT NULL,
  bias          text,           -- what Groq predicted
  actual_bias   text,           -- what actually happened (bullish/bearish/neutral)
  in_range      boolean,        -- was actual_close within predicted range?
  predicted_low  numeric(12,4),
  predicted_high numeric(12,4),
  actual_close  numeric(12,4),
  confidence_pct int,
  lesson        text,           -- Groq's self-critique (what it got wrong and why)
  key_factors   jsonb,          -- original key factors used
  signals_used  jsonb,          -- signal context at prediction time
  created_at    timestamptz DEFAULT now(),
  UNIQUE(ticker, date)
);

CREATE INDEX IF NOT EXISTS prediction_lessons_ticker ON prediction_lessons(ticker, date DESC);
