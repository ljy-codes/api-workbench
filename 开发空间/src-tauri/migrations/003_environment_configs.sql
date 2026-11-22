-- Upgrade inside the same IMMEDIATE transaction as 001/002, after a consistent
-- SQLite backup of the pre-upgrade database (including committed WAL pages).
ALTER TABLE project ADD COLUMN color TEXT
    CHECK (color IS NULL OR (length(color)=7 AND substr(color,1,1)='#'
           AND substr(color,2) NOT GLOB '*[^0-9A-Fa-f]*'));
ALTER TABLE environment ADD COLUMN color TEXT
    CHECK (color IS NULL OR (length(color)=7 AND substr(color,1,1)='#'
           AND substr(color,2) NOT GLOB '*[^0-9A-Fa-f]*'));
ALTER TABLE request ADD COLUMN environment_configs TEXT NOT NULL DEFAULT 'null'
    CHECK (json_valid(environment_configs) AND json_type(environment_configs) IN ('null','object'));

-- No cascading actions: workspace replacement temporarily deletes parents.
-- Deferred composite FKs preserve kept payloads and enforce project ownership.
-- The store removes genuinely orphaned payloads before committing replacement.
CREATE TABLE response_cache (
    request_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    ciphertext BLOB NOT NULL CHECK (typeof(ciphertext)='blob'
        AND length(ciphertext)>0 AND length(ciphertext)<=8454144),
    plaintext_size INTEGER NOT NULL CHECK (plaintext_size>0 AND plaintext_size<=8388608),
    updated_order INTEGER NOT NULL CHECK (updated_order>0),
    PRIMARY KEY (request_id, environment_id),
    FOREIGN KEY (request_id, project_id) REFERENCES request(id, project_id)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (environment_id, project_id) REFERENCES environment(id, project_id)
        DEFERRABLE INITIALLY DEFERRED
);
-- FIFO eviction and environment-side FK/cleanup lookup; request lookup uses PK.
CREATE INDEX response_cache_oldest ON response_cache(updated_order);
CREATE INDEX response_cache_environment ON response_cache(environment_id, project_id);
CREATE TABLE response_cache_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton=1),
    last_order INTEGER NOT NULL CHECK (last_order>=0)
);
INSERT INTO response_cache_state VALUES (1,0);
UPDATE schema_migration SET version=3, applied_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE version=2;

-- Rollback: failed DDL rolls back atomically. For a completed upgrade, stop all
-- instances, preserve the v3 data directory and restore the pre-upgrade backup
-- into a separate directory using its matching old application. No lossy DROP
-- downgrade; environment overrides and cached responses cannot exist in v2.
-- DPAPI ciphertext remains bound to the original Windows user.
