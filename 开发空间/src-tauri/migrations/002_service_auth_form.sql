-- Run only after a successful SQLite backup, with foreign_keys=OFF outside the
-- enclosing IMMEDIATE transaction. Store checks all FKs before commit and turns
-- enforcement back on afterwards. Disabling FK actions preserves request_pair
-- and request-scoped variables while rebuilding their parent table.
-- No new indexes: existing request tree/FK indexes are recreated; JSON fields
-- are loaded by their owner and are not independently searched.
ALTER TABLE service ADD COLUMN headers TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(headers) AND json_type(headers) = 'array');
ALTER TABLE service ADD COLUMN auth TEXT NOT NULL DEFAULT 'null'
    CHECK (json_valid(auth) AND json_type(auth) IN ('null', 'object'));

CREATE TABLE request_v2 (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
    project_id TEXT NOT NULL REFERENCES project(id),
    service_id TEXT NOT NULL,
    folder_id TEXT,
    name TEXT NOT NULL,
    method TEXT NOT NULL CHECK (length(trim(method)) > 0),
    path TEXT NOT NULL,
    body_type TEXT NOT NULL CHECK (body_type IN ('none', 'json', 'text', 'form', 'multipart')),
    body TEXT NOT NULL,
    timeout_ms INTEGER NOT NULL CHECK (timeout_ms > 0),
    position INTEGER NOT NULL CHECK (position >= 0),
    auth TEXT NOT NULL DEFAULT 'null'
        CHECK (json_valid(auth) AND json_type(auth) IN ('null', 'object')),
    form TEXT NOT NULL DEFAULT '[]'
        CHECK (json_valid(form) AND json_type(form) = 'array'),
    UNIQUE (id, project_id),
    FOREIGN KEY (service_id, project_id) REFERENCES service(id, project_id),
    FOREIGN KEY (folder_id, service_id) REFERENCES folder(id, service_id)
);
INSERT INTO request_v2(id, project_id, service_id, folder_id, name, method, path,
                      body_type, body, timeout_ms, position)
    SELECT id, project_id, service_id, folder_id, name, method, path,
           body_type, body, timeout_ms, position FROM request;
DROP TABLE request;
ALTER TABLE request_v2 RENAME TO request;
CREATE INDEX request_tree ON request(service_id, folder_id, position);
CREATE INDEX request_folder ON request(folder_id, service_id);
UPDATE schema_migration SET version=2, applied_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE version=1;

-- Failure rolls back all DDL/data/version changes. Successful upgrade has no
-- lossless SQL downgrade (v1 cannot represent auth/form). To roll back, stop all
-- instances, retain the entire v2 directory, and restore the pre-upgrade backup
-- to a separate data directory with the matching v1 application. DPAPI remains
-- bound to the original Windows user. Never copy a live main/WAL pair manually.
