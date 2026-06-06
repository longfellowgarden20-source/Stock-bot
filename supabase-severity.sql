-- Migrate severity column from int to numeric to support decimal precision (e.g., 7.5, 8.2)
-- This allows for more nuanced signal scoring across all workers

ALTER TABLE signals ALTER COLUMN severity TYPE numeric(4,1);
ALTER TABLE failed_signals ALTER COLUMN severity TYPE numeric(4,1);
