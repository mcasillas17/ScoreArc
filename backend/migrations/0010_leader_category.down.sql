-- Rolling back means the old primary key comes back, and it cannot hold two
-- boards. The non-goals rows are dropped FIRST and deliberately: leaving them
-- would make the ADD CONSTRAINT fail on a duplicate rank, and the failure would
-- arrive as an opaque 23505 in the middle of a rollback.
--
-- Nothing is lost that cannot be re-fetched: /statistics returns the current
-- season's boards on every request, unlike a standings snapshot.
DELETE FROM top_scorer WHERE category <> 'goals';
ALTER TABLE top_scorer DROP CONSTRAINT top_scorer_pkey;
ALTER TABLE top_scorer
  ADD CONSTRAINT top_scorer_pkey
  PRIMARY KEY (competition_id, season_id, rank);
ALTER TABLE top_scorer DROP COLUMN IF EXISTS category;
