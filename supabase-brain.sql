CREATE TABLE IF NOT EXISTS brain_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content     text NOT NULL,
  ticker      text,
  category    text NOT NULL DEFAULT 'general',
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS brain_notes_ticker ON brain_notes(ticker);
CREATE INDEX IF NOT EXISTS brain_notes_created ON brain_notes(created_at DESC);
