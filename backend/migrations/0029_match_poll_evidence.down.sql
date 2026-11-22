SET LOCAL lock_timeout = '30s';

-- Preserve existing poll rows and all scores on rollback.
ALTER TABLE match_poll_status
  DROP COLUMN missing_count, DROP COLUMN missing_ids, DROP COLUMN absent_ids, DROP COLUMN seen_ids;
