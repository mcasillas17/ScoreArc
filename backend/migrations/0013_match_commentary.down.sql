-- Safe to drop outright: every row is reconstructible from
-- match_detail.commentary plus a re-fetch, and the jsonb column is untouched.
DROP TABLE IF EXISTS match_commentary;
