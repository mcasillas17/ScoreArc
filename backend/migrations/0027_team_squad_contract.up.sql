-- T10.3: roster facts the team and squad routes serve, all from the roster
-- payload the squad refresh already fetches. Nullable and additive: rows
-- written before this migration stay NULL until the next roster refresh, and
-- the reader serves NULL location/headshot and falls back to shirt-number
-- order for them.
ALTER TABLE team ADD COLUMN location text;
ALTER TABLE player ADD COLUMN headshot_url text;
ALTER TABLE squad_membership
  ADD COLUMN roster_order int CONSTRAINT squad_membership_roster_order_nonnegative CHECK (roster_order >= 0);
