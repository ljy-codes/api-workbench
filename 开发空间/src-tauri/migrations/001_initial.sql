-- Initial schema only. Executed atomically by Store::open with foreign_keys=ON.
-- No business seed data. Existing/future schemas are never reset automatically.
-- Rollback: failed initialization rolls back its transaction. For an already
-- populated database, restore a consistent pre-upgrade backup with its matching
-- application version; never DROP tables or copy a live WAL database piecemeal.

CREATE TABLE schema_migration (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE project (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
    name TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0)
);
CREATE TABLE workspace_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    active_project_id TEXT REFERENCES project(id) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE environment (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
    project_id TEXT NOT NULL REFERENCES project(id),
    name TEXT NOT NULL,
    is_production INTEGER NOT NULL CHECK (is_production IN (0, 1)),
    position INTEGER NOT NULL CHECK (position >= 0),
    UNIQUE (id, project_id),
    UNIQUE (project_id, name)
);
CREATE TABLE project_state (
    project_id TEXT PRIMARY KEY NOT NULL REFERENCES project(id),
    environment_id TEXT,
    FOREIGN KEY (environment_id, project_id) REFERENCES environment(id, project_id)
);
CREATE TABLE service (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
    project_id TEXT NOT NULL REFERENCES project(id),
    name TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    UNIQUE (id, project_id),
    UNIQUE (project_id, name)
);
CREATE TABLE service_environment (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
    project_id TEXT NOT NULL REFERENCES project(id),
    service_id TEXT NOT NULL,
    environment_id TEXT NOT NULL,
    base_url TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    position INTEGER NOT NULL CHECK (position >= 0),
    UNIQUE (id, project_id),
    UNIQUE (service_id, environment_id),
    FOREIGN KEY (service_id, project_id) REFERENCES service(id, project_id),
    FOREIGN KEY (environment_id, project_id) REFERENCES environment(id, project_id)
);
CREATE INDEX binding_environment ON service_environment(environment_id, project_id);

CREATE TABLE folder (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
    service_id TEXT NOT NULL REFERENCES service(id),
    parent_id TEXT,
    name TEXT NOT NULL,
    position INTEGER NOT NULL CHECK (position >= 0),
    CHECK (parent_id IS NULL OR parent_id <> id),
    UNIQUE (id, service_id),
    FOREIGN KEY (parent_id, service_id) REFERENCES folder(id, service_id)
        DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX folder_root_name ON folder(service_id, name) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX folder_child_name ON folder(service_id, parent_id, name) WHERE parent_id IS NOT NULL;
CREATE INDEX folder_tree ON folder(service_id, parent_id, position);
CREATE INDEX folder_parent ON folder(parent_id, service_id);
-- UNION (not UNION ALL) terminates even if an externally damaged tree has a cycle.
CREATE TRIGGER folder_no_cycle_insert BEFORE INSERT ON folder
WHEN NEW.parent_id IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'folder cycle')
    WHERE EXISTS (
        WITH RECURSIVE ancestors(id) AS (
            SELECT NEW.parent_id
            UNION
            SELECT f.parent_id FROM folder f JOIN ancestors a ON f.id = a.id
                WHERE f.parent_id IS NOT NULL
        )
        SELECT 1 FROM ancestors WHERE id = NEW.id
    );
END;
CREATE TRIGGER folder_no_cycle_update BEFORE UPDATE OF parent_id, id ON folder
WHEN NEW.parent_id IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'folder cycle')
    WHERE EXISTS (
        WITH RECURSIVE ancestors(id) AS (
            SELECT NEW.parent_id
            UNION
            SELECT f.parent_id FROM folder f JOIN ancestors a ON f.id = a.id
                WHERE f.parent_id IS NOT NULL
        )
        SELECT 1 FROM ancestors WHERE id = NEW.id
    );
END;

CREATE TABLE request (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
    project_id TEXT NOT NULL REFERENCES project(id),
    service_id TEXT NOT NULL,
    folder_id TEXT,
    name TEXT NOT NULL,
    method TEXT NOT NULL CHECK (length(trim(method)) > 0),
    path TEXT NOT NULL,
    body_type TEXT NOT NULL CHECK (body_type IN ('none', 'json', 'text')),
    body TEXT NOT NULL,
    timeout_ms INTEGER NOT NULL CHECK (timeout_ms > 0),
    position INTEGER NOT NULL CHECK (position >= 0),
    UNIQUE (id, project_id),
    FOREIGN KEY (service_id, project_id) REFERENCES service(id, project_id),
    FOREIGN KEY (folder_id, service_id) REFERENCES folder(id, service_id)
);
CREATE INDEX request_tree ON request(service_id, folder_id, position);
CREATE INDEX request_folder ON request(folder_id, service_id);
CREATE TABLE request_pair (
    request_id TEXT NOT NULL REFERENCES request(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('query', 'header')),
    id TEXT NOT NULL CHECK (length(trim(id)) > 0),
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    position INTEGER NOT NULL CHECK (position >= 0),
    PRIMARY KEY (request_id, kind, id),
    UNIQUE (request_id, kind, position)
);

-- A polymorphic DTO is mapped to exactly one typed, project-checked owner.
CREATE TABLE variable_scope (
    id INTEGER PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES project(id),
    kind TEXT NOT NULL CHECK (kind IN ('project', 'service', 'environment', 'binding', 'request')),
    owner_id TEXT NOT NULL CHECK (length(trim(owner_id)) > 0),
    project_owner_id TEXT REFERENCES project(id),
    service_id TEXT,
    environment_id TEXT,
    binding_id TEXT,
    request_id TEXT,
    UNIQUE (id, project_id),
    UNIQUE (kind, owner_id),
    CHECK (
        (project_owner_id IS NOT NULL) + (service_id IS NOT NULL) +
        (environment_id IS NOT NULL) + (binding_id IS NOT NULL) +
        (request_id IS NOT NULL) = 1
    ),
    CHECK (
        (kind = 'project' AND project_owner_id IS NOT NULL AND owner_id = project_owner_id AND project_id = project_owner_id) OR
        (kind = 'service' AND service_id IS NOT NULL AND owner_id = service_id) OR
        (kind = 'environment' AND environment_id IS NOT NULL AND owner_id = environment_id) OR
        (kind = 'binding' AND binding_id IS NOT NULL AND owner_id = binding_id) OR
        (kind = 'request' AND request_id IS NOT NULL AND owner_id = request_id)
    ),
    FOREIGN KEY (service_id, project_id) REFERENCES service(id, project_id),
    FOREIGN KEY (environment_id, project_id) REFERENCES environment(id, project_id),
    FOREIGN KEY (binding_id, project_id) REFERENCES service_environment(id, project_id),
    FOREIGN KEY (request_id, project_id) REFERENCES request(id, project_id)
);
CREATE UNIQUE INDEX scope_project ON variable_scope(project_owner_id) WHERE project_owner_id IS NOT NULL;
CREATE UNIQUE INDEX scope_service ON variable_scope(service_id) WHERE service_id IS NOT NULL;
CREATE UNIQUE INDEX scope_environment ON variable_scope(environment_id) WHERE environment_id IS NOT NULL;
CREATE UNIQUE INDEX scope_binding ON variable_scope(binding_id) WHERE binding_id IS NOT NULL;
CREATE UNIQUE INDEX scope_request ON variable_scope(request_id) WHERE request_id IS NOT NULL;

CREATE TABLE variable (
    id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
    project_id TEXT NOT NULL REFERENCES project(id),
    scope_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    value TEXT,
    is_secret INTEGER NOT NULL CHECK (is_secret IN (0, 1)),
    secret_id TEXT UNIQUE,
    position INTEGER NOT NULL CHECK (position >= 0),
    UNIQUE (id, project_id, is_secret),
    UNIQUE (scope_id, name),
    CHECK (
        (is_secret = 0 AND value IS NOT NULL AND secret_id IS NULL) OR
        (is_secret = 1 AND value IS NULL AND secret_id IS NOT NULL AND secret_id = id)
    ),
    FOREIGN KEY (scope_id, project_id) REFERENCES variable_scope(id, project_id),
    FOREIGN KEY (secret_id, project_id) REFERENCES secret(variable_id, project_id)
        DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE secret (
    variable_id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL,
    is_secret INTEGER NOT NULL DEFAULT 1 CHECK (is_secret = 1),
    ciphertext BLOB NOT NULL CHECK (typeof(ciphertext) = 'blob' AND length(ciphertext) > 0),
    UNIQUE (variable_id, project_id),
    FOREIGN KEY (variable_id, project_id, is_secret)
        REFERENCES variable(id, project_id, is_secret) ON DELETE CASCADE
);

INSERT INTO workspace_state(singleton, revision, active_project_id) VALUES (1, 0, NULL);
INSERT INTO schema_migration(version) VALUES (1);
