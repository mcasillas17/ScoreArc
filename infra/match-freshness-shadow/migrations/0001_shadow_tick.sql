CREATE TABLE shadow_tick (
    tick INTEGER PRIMARY KEY,
    previous_tick INTEGER,
    started_ms INTEGER NOT NULL,
    finished_ms INTEGER NOT NULL CHECK (finished_ms >= started_ms),
    requests INTEGER NOT NULL CHECK (requests BETWEEN 1 AND 32),
    editions TEXT NOT NULL CHECK (json_valid(editions))
);

-- Two days of comparison evidence. A pause always leaves the last checkpoint intact.
CREATE TRIGGER prune_shadow_ticks AFTER INSERT ON shadow_tick
BEGIN
    DELETE FROM shadow_tick WHERE tick < NEW.tick - 172800000;
END;
