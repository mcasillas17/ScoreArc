-- The club's own colours, so a team page can feel like that club's page rather
-- than like the competition's.
--
-- Source: the roster payload the ingester already fetches daily carries
-- team.color, so the primary costs no extra request. alternateColor appears
-- only on /teams/{id}, which the ingester does not fetch -- roughly 180 extra
-- requests a day for a second tint -- so it is left null until something needs
-- it. A null here is honest: we do not know the club's alternate colour.
--
-- Stored as the provider sends it, six hex digits with no leading '#'
-- ('ffff91'), and the '#' is added at the edge that renders it. Storing the
-- punctuation would mean stripping it on every consumer that is not CSS.
ALTER TABLE team
  ADD COLUMN IF NOT EXISTS color           text,
  ADD COLUMN IF NOT EXISTS alternate_color text;

-- Six hex digits or nothing. Without this a truncated or prefixed value is
-- stored happily and only fails much later, in a stylesheet, as a colour that
-- silently does not apply.
ALTER TABLE team
  ADD CONSTRAINT team_color_hex
    CHECK (color IS NULL OR color ~ '^[0-9a-fA-F]{6}$'),
  ADD CONSTRAINT team_alternate_color_hex
    CHECK (alternate_color IS NULL OR alternate_color ~ '^[0-9a-fA-F]{6}$');

-- The reader already has SELECT on team from 0001. The ingester writes these
-- during the squad refresh, and it holds INSERT/UPDATE on team from 0001, so
-- no new grant is needed -- stated here so the absence reads as deliberate
-- rather than forgotten.
