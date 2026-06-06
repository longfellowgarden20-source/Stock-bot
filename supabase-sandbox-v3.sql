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

-- #1: mtm_balance on equity snapshots
ALTER TABLE sandbox_equity ADD COLUMN IF NOT EXISTS mtm_balance numeric(14,2);

-- #2: user notes on trades
ALTER TABLE sandbox_trades ADD COLUMN IF NOT EXISTS user_note text;

-- #12: thesis validation field
ALTER TABLE sandbox_trades ADD COLUMN IF NOT EXISTS thesis_correct boolean;

-- #26: structured thesis JSON
ALTER TABLE sandbox_trades ADD COLUMN IF NOT EXISTS thesis_structured jsonb;

-- #27: model used for entry
ALTER TABLE sandbox_trades ADD COLUMN IF NOT EXISTS model_used text;

-- #8: scale-in tracking
ALTER TABLE sandbox_trades ADD COLUMN IF NOT EXISTS scaled_in boolean DEFAULT false;

-- ─── Watchlist seed: comprehensive ticker universe ─────────────────────────
-- Adds new tickers to watchlist with ON CONFLICT DO NOTHING to skip dupes.
-- Run in Supabase SQL Editor.
INSERT INTO watchlist (ticker, name, sector, alert_threshold_pct, pinned, muted)
VALUES
  -- AI / Semis
  ('ARM',  'ARM Holdings',             'Technology',   3.0, false, false),
  ('ASML', 'ASML Holding',             'Technology',   3.0, false, false),
  ('TSM',  'Taiwan Semiconductor',     'Technology',   3.0, false, false),
  ('SMCI', 'Super Micro Computer',     'Technology',   5.0, false, false),
  ('MCHP', 'Microchip Technology',     'Technology',   3.0, false, false),
  ('ON',   'ON Semiconductor',         'Technology',   4.0, false, false),
  -- AI infrastructure
  ('AI',   'C3.ai',                    'Technology',   6.0, false, false),
  ('BBAI', 'BigBear.ai',               'Technology',   8.0, false, false),
  ('SOUN', 'SoundHound AI',            'Technology',   8.0, false, false),
  -- Quantum computing
  ('IONQ', 'IonQ',                     'Technology',   8.0, false, false),
  ('RGTI', 'Rigetti Computing',        'Technology',   10.0, false, false),
  ('QUBT', 'Quantum Computing',        'Technology',   10.0, false, false),
  -- Crypto / Bitcoin proxies
  ('MSTR', 'MicroStrategy',            'Finance',      6.0, false, false),
  ('MARA', 'Marathon Digital',         'Finance',      8.0, false, false),
  ('RIOT', 'Riot Platforms',           'Finance',      8.0, false, false),
  ('CLSK', 'CleanSpark',               'Finance',      8.0, false, false),
  ('COIN', 'Coinbase',                 'Finance',      5.0, false, false),
  ('HOOD', 'Robinhood',                'Finance',      5.0, false, false),
  -- High-volume fintech
  ('SOFI', 'SoFi Technologies',        'Finance',      5.0, false, false),
  ('AFRM', 'Affirm Holdings',          'Finance',      6.0, false, false),
  ('UPST', 'Upstart Holdings',         'Finance',      8.0, false, false),
  -- Biotech / health
  ('MRNA', 'Moderna',                  'Healthcare',   5.0, false, false),
  ('RXRX', 'Recursion Pharma',         'Healthcare',   7.0, false, false),
  ('HIMS', 'Hims & Hers Health',       'Healthcare',   7.0, false, false),
  ('CRSP', 'CRISPR Therapeutics',      'Healthcare',   6.0, false, false),
  ('TDOC', 'Teladoc Health',           'Healthcare',   6.0, false, false),
  -- Defense / drone
  ('KTOS', 'Kratos Defense',           'Defense',      5.0, false, false),
  ('RCAT', 'Red Cat Holdings',         'Defense',      10.0, false, false),
  ('AXON', 'Axon Enterprise',          'Defense',      4.0, false, false),
  -- Consumer / media
  ('NFLX', 'Netflix',                  'Technology',   4.0, false, false),
  ('SNAP', 'Snap',                     'Technology',   7.0, false, false),
  ('RDDT', 'Reddit',                   'Technology',   7.0, false, false),
  ('DKNG', 'DraftKings',               'Consumer',     6.0, false, false),
  ('DASH', 'DoorDash',                 'Consumer',     5.0, false, false),
  ('ABNB', 'Airbnb',                   'Consumer',     4.0, false, false),
  ('UBER', 'Uber Technologies',        'Consumer',     4.0, false, false),
  -- Uranium / clean energy
  ('CCJ',  'Cameco',                   'Energy',       5.0, false, false),
  ('UEC',  'Uranium Energy',           'Energy',       8.0, false, false),
  -- eVTOL / air taxi
  ('JOBY', 'Joby Aviation',            'Industrial',   10.0, false, false),
  ('ACHR', 'Archer Aviation',          'Industrial',   10.0, false, false),
  -- High-beta favorites
  ('PLTR', 'Palantir',                 'Technology',   5.0, false, false),
  ('RIVN', 'Rivian Automotive',        'Consumer',     7.0, false, false),
  ('LCID', 'Lucid Motors',             'Consumer',     8.0, false, false),
  ('GME',  'GameStop',                 'Consumer',     10.0, false, false),
  ('AMC',  'AMC Entertainment',        'Consumer',     10.0, false, false),
  -- Core large-caps (if not already in watchlist)
  ('NVDA', 'NVIDIA',                   'Technology',   3.0, false, false),
  ('AAPL', 'Apple',                    'Technology',   2.5, false, false),
  ('MSFT', 'Microsoft',                'Technology',   2.5, false, false),
  ('META', 'Meta Platforms',           'Technology',   3.0, false, false),
  ('GOOGL','Alphabet',                 'Technology',   2.5, false, false),
  ('AMZN', 'Amazon',                   'Technology',   2.5, false, false),
  ('TSLA', 'Tesla',                    'Technology',   4.0, false, false),
  ('AMD',  'AMD',                      'Technology',   4.0, false, false),
  ('AVGO', 'Broadcom',                 'Technology',   3.0, false, false),
  ('MU',   'Micron Technology',        'Technology',   4.0, false, false),
  ('ORCL', 'Oracle',                   'Technology',   3.0, false, false),
  ('CRM',  'Salesforce',               'Technology',   3.0, false, false),
  ('NOW',  'ServiceNow',               'Technology',   3.0, false, false),
  ('CRWD', 'CrowdStrike',              'Technology',   4.0, false, false),
  ('PANW', 'Palo Alto Networks',       'Technology',   3.0, false, false),
  ('NET',  'Cloudflare',               'Technology',   5.0, false, false),
  ('SNOW', 'Snowflake',                'Technology',   5.0, false, false),
  ('DDOG', 'Datadog',                  'Technology',   5.0, false, false),
  -- Finance core
  ('JPM',  'JPMorgan Chase',           'Finance',      2.5, false, false),
  ('GS',   'Goldman Sachs',            'Finance',      3.0, false, false),
  ('V',    'Visa',                     'Finance',      2.5, false, false),
  ('MA',   'Mastercard',               'Finance',      2.5, false, false),
  ('PYPL', 'PayPal',                   'Finance',      4.0, false, false),
  -- Healthcare core
  ('LLY',  'Eli Lilly',                'Healthcare',   3.0, false, false),
  ('ABBV', 'AbbVie',                   'Healthcare',   3.0, false, false),
  ('UNH',  'UnitedHealth',             'Healthcare',   2.5, false, false),
  -- Energy core
  ('XOM',  'ExxonMobil',              'Energy',       2.5, false, false),
  ('CVX',  'Chevron',                  'Energy',       2.5, false, false),
  ('OXY',  'Occidental Petroleum',     'Energy',       4.0, false, false),
  -- Defense core
  ('LMT',  'Lockheed Martin',          'Defense',      2.5, false, false),
  ('RTX',  'RTX Corporation',          'Defense',      2.5, false, false),
  ('NOC',  'Northrop Grumman',         'Defense',      2.5, false, false)
ON CONFLICT (ticker) DO NOTHING;

-- #4: Snapshot retention — auto-delete snapshots > 90 days old
CREATE OR REPLACE FUNCTION delete_old_snapshots()
RETURNS void AS $$
BEGIN
  DELETE FROM snapshots WHERE created_at < NOW() - INTERVAL '90 days';
END;
$$ LANGUAGE plpgsql;

-- Runs daily at 2am UTC (10pm ET)
SELECT cron.schedule(
  'delete_old_snapshots_daily',
  '0 2 * * *',
  'SELECT delete_old_snapshots()'
);

-- #7: Stale data warnings — track last successful price update per ticker
ALTER TABLE snapshots
  ADD COLUMN IF NOT EXISTS data_freshness TIMESTAMP WITH TIME ZONE DEFAULT NOW();

-- Index for dashboard queries (stale data check)
CREATE INDEX IF NOT EXISTS snapshots_ticker_freshness
  ON snapshots (ticker, data_freshness DESC);
