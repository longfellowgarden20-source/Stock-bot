-- Migrate severity columns from integer to numeric(4,1) to support decimal precision
-- Run this against your Supabase project via the SQL editor or psql

ALTER TABLE signals ALTER COLUMN severity TYPE numeric(4,1);
ALTER TABLE failed_signals ALTER COLUMN severity TYPE numeric(4,1);
