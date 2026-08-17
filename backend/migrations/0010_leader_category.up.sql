-- top_scorer becomes a leaderboard table rather than a goals table.
--
-- assistsLeaders ships in the SAME /statistics response the ingester already
-- fetches for the Golden Boot -- 50 rows each, verified in the repo's own
-- shared/espn/testdata/espn-statistics.json -- and MapTopScorers discarded it
-- with `if block.Name == "goalsLeaders"`.
--
-- The table keeps its name. Renaming it to `season_leader` would be tidier and
-- would also rewrite the reader's query, its OpenAPI schema and its integration
-- fixtures for zero behavioural gain. The column carries the meaning; the name
-- is just a name, and a rename is a separate, optional change.
--
-- DEFAULT 'goals' on the new column is what makes this migration safe against
-- existing rows: every row already in the table IS a goals row.
ALTER TABLE top_scorer
  ADD COLUMN category text NOT NULL DEFAULT 'goals';

-- The rank is only unique WITHIN a category: rank 1 for goals and rank 1 for
-- assists are different players. Without category in the key the second board
-- would silently overwrite the first, one row at a time, with no error.
ALTER TABLE top_scorer DROP CONSTRAINT top_scorer_pkey;
ALTER TABLE top_scorer
  ADD CONSTRAINT top_scorer_pkey
  PRIMARY KEY (competition_id, season_id, category, rank);
