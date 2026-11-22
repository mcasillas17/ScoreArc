SET LOCAL lock_timeout = '30s';

-- Extend the existing full-poll row: the latest and rolling rows keep empty sets.
ALTER TABLE match_poll_status
  ADD COLUMN seen_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN absent_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN missing_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN missing_count integer GENERATED ALWAYS AS (cardinality(missing_ids)) STORED,
  ADD CONSTRAINT match_poll_evidence_id_budget CHECK (cardinality(seen_ids) + cardinality(absent_ids) <= 5000),
  ADD CHECK (missing_ids <@ absent_ids AND cardinality(missing_ids) <= cardinality(absent_ids));
