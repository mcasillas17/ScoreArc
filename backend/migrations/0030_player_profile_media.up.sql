-- Existing profiles acquire observed media on their next roster and bio refresh.
SET LOCAL lock_timeout = '30s';
ALTER TABLE player ADD COLUMN flag_url text, ADD COLUMN bio_retry_after timestamptz;
ALTER TABLE player_team_history ADD COLUMN crest_url text;
