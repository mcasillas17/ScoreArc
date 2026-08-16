-- Drops the columns, never the appearances. A summary for a finished match can
-- usually be re-fetched, but the appearance rows themselves encode identity
-- resolution that would have to be redone.
ALTER TABLE appearance
  DROP COLUMN IF EXISTS shots_faced,
  DROP COLUMN IF EXISTS goals_conceded,
  DROP COLUMN IF EXISTS saves,
  DROP COLUMN IF EXISTS red_cards,
  DROP COLUMN IF EXISTS yellow_cards,
  DROP COLUMN IF EXISTS own_goals,
  DROP COLUMN IF EXISTS fouls_suffered,
  DROP COLUMN IF EXISTS fouls_committed,
  DROP COLUMN IF EXISTS offsides,
  DROP COLUMN IF EXISTS shots_on_target,
  DROP COLUMN IF EXISTS shots,
  DROP COLUMN IF EXISTS assists,
  DROP COLUMN IF EXISTS goals;
