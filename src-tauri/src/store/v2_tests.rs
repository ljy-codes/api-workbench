use super::*;
use tempfile::tempdir;

fn legacy(path: &Path) -> Connection {
    let db = Connection::open(path).unwrap();
    db.execute_batch(INITIAL_SCHEMA).unwrap();
    db.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; PRAGMA foreign_keys=ON;
         BEGIN;
         INSERT INTO project VALUES ('p','项目',0);
         INSERT INTO environment VALUES ('e','p','测试',0,0);
         INSERT INTO project_state VALUES ('p','e');
         INSERT INTO service VALUES ('s','p','服务',0);
         INSERT INTO service_environment VALUES ('b','p','s','e','https://example.invalid',1,0);
         INSERT INTO folder VALUES ('f','s',NULL,'目录',0);
         INSERT INTO request VALUES ('r','p','s','f','接口','POST','/','text','legacy body',30000,0);
         INSERT INTO request_pair VALUES ('r','header','h','X-Old','old',1,0);
         INSERT INTO variable_scope(id,project_id,kind,owner_id,request_id) VALUES (1,'p','request','r','r');
         INSERT INTO variable VALUES ('v','p',1,'token','old value',0,NULL,0);
         UPDATE workspace_state SET revision=42,active_project_id='p';
         COMMIT;",
    ).unwrap();
    db
}

fn version(db: &Connection) -> i64 {
    db.query_row("SELECT version FROM schema_migration", [], |r| r.get(0))
        .unwrap()
}

fn backups(path: &Path) -> Vec<std::path::PathBuf> {
    std::fs::read_dir(path.parent().unwrap().join("backups"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect()
}

fn input(workspace: &Workspace) -> ExecuteInput {
    ExecuteInput {
        execution_id: "execution".into(),
        environment_id: "e".into(),
        request: workspace.requests[0].clone(),
        temporary_variables: vec![],
        production_confirmed: false,
    }
}

fn pair(id: &str, key: &str, value: &str, enabled: bool) -> Pair {
    Pair {
        id: id.into(),
        key: key.into(),
        value: value.into(),
        enabled,
    }
}

// Pure selector tests provide already-available values; load_for_request tests
// exercise the real DPAPI-backed header-name resolver on a SQLite snapshot.
fn request_secret_indices(
    workspace: &Workspace,
    input: &ExecuteInput,
) -> Result<Vec<usize>, String> {
    super::request_secret_indices(workspace, input, |index| {
        Ok(workspace.variables[index].value.clone())
    })
}

#[test]
fn migrates_real_v1_wal_and_backs_up_before_mutation() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("旧库.sqlite");
    let old = legacy(&path); // Keep WAL live: copying only the main file loses rows.
    let store = Store::open(&path).unwrap();
    assert_eq!(version(&old), 2);
    let workspace = store.load().unwrap();
    assert_eq!(workspace.revision, 42);
    assert_eq!(workspace.requests[0].headers[0].value, "old");
    assert_eq!(workspace.variables[0].value, "old value");
    assert!(workspace.services[0].headers.is_empty());
    assert!(workspace.services[0].auth.is_none());
    assert!(workspace.requests[0].auth.is_none());
    assert!(workspace.requests[0].form.is_empty());
    let files = backups(&path);
    assert_eq!(files.len(), 1);
    let backup = Connection::open(&files[0]).unwrap();
    assert_eq!(version(&backup), 1);
    assert_eq!(
        backup
            .query_row("SELECT revision FROM workspace_state", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        42
    );
    assert_eq!(
        backup
            .query_row("SELECT count(*) FROM request_pair", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        backup
            .query_row(
                "SELECT count(*) FROM pragma_table_info('service') WHERE name='auth'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    drop(store);
    Store::open(&path).unwrap();
    assert_eq!(
        backups(&path).len(),
        1,
        "reopening v2 must not migrate again"
    );
}

#[test]
fn backup_failure_prevents_any_schema_or_revision_mutation() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("legacy.sqlite");
    let db = legacy(&path);
    std::fs::write(dir.path().join("backups"), "blocked-sensitive-path").unwrap();
    let result = Store::open(&path);
    assert!(result.is_err());
    let error = result.err().unwrap();
    assert!(!error.contains("blocked-sensitive-path") && !error.contains("legacy.sqlite"));
    assert_eq!(version(&db), 1);
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM pragma_table_info('service')",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        4
    );
    assert_eq!(
        db.query_row("SELECT revision FROM workspace_state", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        42
    );
}

#[test]
fn real_migration_failure_rolls_back_ddl_and_keeps_backup() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("rollback.sqlite");
    let db = legacy(&path);
    db.execute_batch("CREATE TRIGGER fail_upgrade BEFORE UPDATE ON schema_migration BEGIN SELECT RAISE(ABORT,'private-trigger-secret'); END;").unwrap();
    let result = Store::open(&path);
    assert!(result.is_err());
    assert!(!result.err().unwrap().contains("private-trigger-secret"));
    assert_eq!(version(&db), 1);
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM pragma_table_info('service')",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        4
    );
    assert!(db
        .execute("UPDATE request SET body_type='form'", [])
        .is_err());
    assert_eq!(
        db.query_row("SELECT value FROM request_pair", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "old"
    );
    assert_eq!(backups(&path).len(), 1);
    assert_eq!(version(&Connection::open(&backups(&path)[0]).unwrap()), 1);
}

#[test]
fn fresh_database_has_v2_and_unknown_single_version_is_rejected() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("fresh.sqlite");
    Store::open(&path).unwrap();
    let db = Connection::open(&path).unwrap();
    assert_eq!(version(&db), 2);
    assert!(!dir.path().join("backups").exists());
    db.execute("UPDATE schema_migration SET version=999", [])
        .unwrap();
    assert!(Store::open(&path).is_err());
    assert_eq!(version(&db), 999);
}

#[test]
fn v2_fields_round_trip_and_auth_secrets_reject_plaintext_even_when_inactive() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("roundtrip.sqlite");
    legacy(&path);
    let store = Store::open(&path).unwrap();
    let mut workspace = store.load().unwrap();
    workspace.services[0].headers = vec![
        pair("a", "X-Default", "{{token}}", true),
        pair("b", "X-Default", "", false),
    ];
    workspace.services[0].auth = Some(AuthConfig {
        kind: "basic".into(),
        username: "literal user".into(),
        password: "{{ token }}".into(),
        ..Default::default()
    });
    workspace.requests[0].auth = Some(AuthConfig {
        kind: "none".into(),
        ..Default::default()
    });
    workspace.requests[0].form = vec![
        FormField {
            id: "text".into(),
            key: "same".into(),
            value: "{{token}}".into(),
            enabled: true,
            kind: "text".into(),
        },
        FormField {
            id: "file".into(),
            key: "same".into(),
            value: "C:\\中文\\file.txt".into(),
            enabled: false,
            kind: "file".into(),
        },
    ];
    for body_type in ["form", "multipart"] {
        workspace.requests[0].body_type = body_type.into();
        let mut expected = serde_json::to_value(&workspace).unwrap();
        expected["revision"] = (workspace.revision + 1).into();
        workspace = store.save(workspace).unwrap();
        assert_eq!(serde_json::to_value(&workspace).unwrap(), expected);
        assert_eq!(
            serde_json::to_value(store.load().unwrap()).unwrap(),
            expected
        );
    }
    for service in [false, true] {
        for field in ["token", "password", "value"] {
            for invalid in [
                "raw-private-credential",
                "Bearer {{token}}",
                "{{token}}{{token}}",
                "{{}}",
                "{{a\nb}}",
                " {{token}}",
                "{{nested{}}",
            ] {
                let mut candidate = workspace.clone();
                let auth = if service {
                    candidate.services[0].auth.as_mut().unwrap()
                } else {
                    candidate.requests[0].auth.as_mut().unwrap()
                };
                match field {
                    "token" => auth.token = invalid.into(),
                    "password" => auth.password = invalid.into(),
                    _ => auth.value = invalid.into(),
                }
                let result = store.save(candidate);
                assert!(result.is_err(), "{field}: accepted literal credential");
                assert!(!result.err().unwrap().contains(invalid));
                assert_eq!(store.load().unwrap().revision, workspace.revision);
            }
        }
    }
}

#[test]
fn effective_headers_auth_and_form_select_only_referenced_secrets() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("selector.sqlite");
    legacy(&path);
    let store = Store::open(&path).unwrap();
    let mut workspace = store.load().unwrap();
    workspace.variables[0].is_secret = true;
    workspace.services[0].headers = vec![
        pair("h", "X-Key", "{{missing}}", true),
        pair("off", "Off", "{{missing}}", false),
    ];
    workspace.services[0].auth = Some(AuthConfig {
        kind: "bearer".into(),
        token: "{{missing}}".into(),
        ..Default::default()
    });
    let mut request = input(&workspace);
    request.request.headers = vec![pair("override", "x-kEy", "literal", true)];
    request.request.auth = Some(AuthConfig {
        kind: "none".into(),
        ..Default::default()
    });
    request.request.body_type = "none".into();
    assert!(request_secret_indices(&workspace, &request)
        .unwrap()
        .is_empty());
    request.request.headers[0].enabled = false;
    assert!(
        request_secret_indices(&workspace, &request).is_err(),
        "disabled override must not hide active service header"
    );
    workspace.services[0].headers.clear();
    workspace.services[0].auth.as_mut().unwrap().token = "{{token}}".into();
    request.request.auth = None;
    assert_eq!(
        request_secret_indices(&workspace, &request).unwrap(),
        vec![0]
    );
    request.request.auth = Some(AuthConfig {
        kind: "none".into(),
        ..Default::default()
    });
    for body_type in ["form", "multipart"] {
        request.request.body_type = body_type.into();
        request.request.body = "{{missing}}".into();
        request.request.form = vec![
            FormField {
                id: "t".into(),
                key: "{{token}}".into(),
                value: "{{token}}".into(),
                enabled: true,
                kind: "text".into(),
            },
            FormField {
                id: "off".into(),
                key: "{{missing}}".into(),
                value: "{{missing}}".into(),
                enabled: false,
                kind: "text".into(),
            },
        ];
        assert_eq!(
            request_secret_indices(&workspace, &request).unwrap(),
            vec![0]
        );
    }
}

#[cfg(windows)]
#[test]
fn v1_migration_preserves_dpapi_ciphertext_and_revision() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("secret.sqlite");
    let db = legacy(&path);
    let ciphertext = secrets::protect("private-dpapi-secret").unwrap();
    db.execute_batch("BEGIN; UPDATE variable SET value=NULL,is_secret=1,secret_id=id;")
        .unwrap();
    db.execute(
        "INSERT INTO secret(variable_id,project_id,ciphertext) VALUES ('v','p',?1)",
        [&ciphertext],
    )
    .unwrap();
    db.execute_batch("COMMIT").unwrap();
    let store = Store::open(&path).unwrap();
    assert_eq!(store.load().unwrap().revision, 42);
    assert_eq!(store.load().unwrap().variables[0].value, "");
    assert_eq!(
        store.load_for_execution().unwrap().variables[0].value,
        "private-dpapi-secret"
    );
    for connection in [&db, &Connection::open(&backups(&path)[0]).unwrap()] {
        assert_eq!(
            connection
                .query_row("SELECT ciphertext FROM secret", [], |r| r
                    .get::<_, Vec<u8>>(0))
                .unwrap(),
            ciphertext
        );
    }
}

#[test]
fn explicit_backups_are_unique_standalone_wal_snapshots_without_mutation() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("manual.sqlite");
    legacy(&path);
    let store = Store::open(&path).unwrap();
    let mut workspace = store.load().unwrap();
    workspace.requests[0].body = "committed WAL content".into();
    let saved = store.save(workspace).unwrap();
    let first = store.backup().unwrap();
    let second = store.backup().unwrap();
    assert_ne!(first, second);
    assert_eq!(first.parent(), Some(dir.path().join("backups").as_path()));
    assert_eq!(store.load().unwrap().revision, saved.revision);
    let restored = dir.path().join("restored.sqlite");
    std::fs::copy(&first, &restored).unwrap(); // only a completed standalone backup
    assert_eq!(
        serde_json::to_value(Store::open(&restored).unwrap().load().unwrap()).unwrap(),
        serde_json::to_value(&saved).unwrap()
    );
    assert!(!first.with_extension("sqlite-wal").exists());
}

#[test]
fn multipart_file_path_templates_are_selected_for_actual_execution() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("file-template.sqlite");
    legacy(&path);
    let mut workspace = Store::open(&path).unwrap().load().unwrap();
    workspace.variables[0].is_secret = true;
    let mut request = input(&workspace);
    request.request.body_type = "multipart".into();
    request.request.form.push(FormField {
        id: "file".into(),
        key: "upload".into(),
        value: "{{token}}".into(),
        enabled: true,
        kind: "file".into(),
    });
    assert_eq!(
        request_secret_indices(&workspace, &request).unwrap(),
        vec![0]
    );
}

#[cfg(windows)]
#[test]
fn effective_v2_surfaces_decrypt_only_the_winner_not_disabled_or_overridden_secrets() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("effective-secrets.sqlite");
    legacy(&path);
    let store = Store::open(&path).unwrap();
    let mut workspace = store.load().unwrap();
    workspace.variables[0].is_secret = true;
    workspace.variables[0].value = "wanted-secret".into();
    workspace.variables.push(Variable {
        id: "unused".into(),
        name: "unused".into(),
        value: "other-secret".into(),
        ..workspace.variables[0].clone()
    });
    workspace.services[0].headers = vec![
        pair("overridden", "X-Overridden", "{{unused}}", true),
        pair("disabled", "{{unused}}", "{{unused}}", false),
    ];
    workspace.services[0].auth = Some(AuthConfig {
        kind: "bearer".into(),
        token: "{{unused}}".into(),
        ..Default::default()
    });
    workspace.requests[0].headers = vec![
        pair("override", "x-overridden", "literal", true),
        pair("duplicate", "x-overridden", "another", true),
    ];
    workspace.requests[0].auth = Some(AuthConfig {
        kind: "none".into(),
        token: "{{unused}}".into(),
        ..Default::default()
    });
    workspace.requests[0].body_type = "none".into();
    let mut saved = store.save(workspace).unwrap();
    let db = Connection::open(&path).unwrap();
    db.execute(
        "UPDATE secret SET ciphertext=x'626164' WHERE variable_id='unused'",
        [],
    )
    .unwrap();
    let base = input(&saved);
    assert!(store
        .load_for_request(&base)
        .unwrap()
        .variables
        .iter()
        .all(|v| v.value.is_empty()));
    let mut cases = Vec::new();
    for auth in [
        AuthConfig {
            kind: "bearer".into(),
            token: "{{token}}".into(),
            password: "{{unused}}".into(),
            ..Default::default()
        },
        AuthConfig {
            kind: "basic".into(),
            username: "literal".into(),
            password: "{{token}}".into(),
            value: "{{unused}}".into(),
            ..Default::default()
        },
        AuthConfig {
            kind: "basic".into(),
            username: "{{token}}".into(),
            ..Default::default()
        },
        AuthConfig {
            kind: "apiKey".into(),
            key: "X-Key".into(),
            value: "{{token}}".into(),
            location: "header".into(),
            token: "{{unused}}".into(),
            ..Default::default()
        },
        AuthConfig {
            kind: "apiKey".into(),
            key: "{{token}}".into(),
            value: String::new(),
            location: "query".into(),
            ..Default::default()
        },
    ] {
        let mut case = base.clone();
        case.request.auth = Some(auth);
        cases.push(case);
    }
    for kind in ["form", "multipart"] {
        let mut case = base.clone();
        case.request.body_type = kind.into();
        case.request.body = "{{unused}}".into();
        case.request.form = vec![
            FormField {
                id: "text".into(),
                key: "{{token}}".into(),
                value: "{{token}}".into(),
                enabled: true,
                kind: "text".into(),
            },
            FormField {
                id: "off".into(),
                key: "{{unused}}".into(),
                value: "{{unused}}".into(),
                enabled: false,
                kind: "file".into(),
            },
        ];
        cases.push(case);
    }
    for case in cases {
        let snapshot = store.load_for_request(&case).unwrap();
        assert_eq!(snapshot.variables[0].value, "wanted-secret");
        assert_eq!(snapshot.variables[1].value, "");
    }
    // Service inheritance also uses the persisted configuration, not just input.
    saved.services[0]
        .headers
        .push(pair("active", "X-Active", "{{token}}", true));
    saved.services[0].auth.as_mut().unwrap().token = "{{token}}".into();
    let saved = store.save(saved).unwrap(); // opaque corrupt ciphertext is preserved
    let mut inherited = input(&saved);
    inherited.request.auth = None;
    assert_eq!(
        store.load_for_request(&inherited).unwrap().variables[0].value,
        "wanted-secret"
    );
    db.execute(
        "UPDATE secret SET ciphertext=x'626164' WHERE variable_id='v'",
        [],
    )
    .unwrap();
    assert!(store
        .load_for_request(&inherited)
        .unwrap_err()
        .contains("DPAPI"));
}

#[test]
fn corrupted_v2_json_is_rejected_without_repair_or_sensitive_error() {
    for (table, column, corrupt) in [
        (
            "service",
            "headers",
            r#"[{"id":"private-json-content","enabled":"wrong"}]"#,
        ),
        (
            "service",
            "auth",
            r#"{"kind":"bearer","token":"private-json-content"}"#,
        ),
        (
            "request",
            "auth",
            r#"{"kind":"none","password":"private-json-content"}"#,
        ),
        (
            "request",
            "form",
            r#"[{"id":"private-json-content","key":"k","value":"v","enabled":true,"kind":"unknown"}]"#,
        ),
    ] {
        let dir = tempdir().unwrap();
        let path = dir.path().join("corrupt-v2.sqlite");
        legacy(&path);
        let store = Store::open(&path).unwrap();
        let saved = store.load().unwrap();
        let db = Connection::open(&path).unwrap();
        db.execute(&format!("UPDATE {table} SET {column}=?1"), [corrupt])
            .unwrap();
        assert!(!store.load().unwrap_err().contains("private-json-content"));
        assert!(
            store.save(saved).is_err(),
            "must not overwrite a damaged database"
        );
        assert!(Store::open(&path).is_err());
        assert!(store.backup().is_err());
        assert_eq!(
            db.query_row(&format!("SELECT {column} FROM {table}"), [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            corrupt
        );
        assert_eq!(
            db.query_row("SELECT revision FROM workspace_state", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            42
        );
    }
}

#[test]
fn failed_upgrade_preserves_ciphertext_and_cannot_leave_partial_schema() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("failed-secret.sqlite");
    let db = legacy(&path);
    db.execute_batch(
        "BEGIN;
         UPDATE variable SET value=NULL,is_secret=1,secret_id=id;
         INSERT INTO secret(variable_id,project_id,ciphertext) VALUES ('v','p',x'626164');
         COMMIT;
         CREATE TRIGGER fail_upgrade BEFORE UPDATE ON schema_migration
         BEGIN SELECT RAISE(ABORT,'secret-error'); END;",
    )
    .unwrap();
    assert!(Store::open(&path).is_err());
    assert_eq!(version(&db), 1);
    assert_eq!(
        db.query_row("SELECT ciphertext FROM secret", [], |r| r
            .get::<_, Vec<u8>>(0))
            .unwrap(),
        b"bad"
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
            .get::<_, i64>(
            0
        ))
        .unwrap(),
        0
    );
    db.execute_batch("DROP TRIGGER fail_upgrade").unwrap();
    let store = Store::open(&path).unwrap();
    assert_eq!(store.load().unwrap().revision, 42);
    assert_eq!(store.load().unwrap().variables[0].value, "");
}

#[test]
fn backups_keep_revision_and_values_in_one_snapshot_during_concurrent_saves() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("backup-race.sqlite");
    legacy(&path);
    let reader = Store::open(&path).unwrap();
    let writer = Store::open(&path).unwrap();
    let mut workspace = writer.load().unwrap();
    workspace.requests[0].body = "revision-43".into();
    let saved = writer.save(workspace).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let other = barrier.clone();
    let writing = std::thread::spawn(move || {
        let mut saved = saved;
        other.wait();
        for revision in 44..=55 {
            saved.requests[0].body = format!("revision-{revision}");
            saved = writer.save(saved).unwrap();
        }
    });
    barrier.wait();
    let mut names = HashSet::new();
    for _ in 0..8 {
        let path = reader.backup().unwrap();
        assert!(names.insert(path.clone()));
        let db = Connection::open(path).unwrap();
        let revision: u64 = db
            .query_row("SELECT revision FROM workspace_state", [], |r| r.get(0))
            .unwrap();
        let body: String = db
            .query_row("SELECT body FROM request", [], |r| r.get(0))
            .unwrap();
        assert_eq!(body, format!("revision-{revision}"));
        assert_eq!(
            db.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
    }
    writing.join().unwrap();
    assert_eq!(reader.load().unwrap().revision, 55);
}

#[test]
fn expanded_header_override_ignores_missing_service_values_and_disabled_names() {
    for (service_key, request_key) in [
        ("X-Group", "{{h}}"),
        ("{{h}}", "X-GROUP"),
        ("{{h}}", "{{other}}"),
        ("X-{{part}}", "{{other}}"),
    ] {
        let dir = tempdir().unwrap();
        let path = dir.path().join("expanded-header.sqlite");
        legacy(&path);
        let store = Store::open(&path).unwrap();
        let mut workspace = store.load().unwrap();
        for (name, value) in [("h", "x-group"), ("other", "X-Group"), ("part", "Group")] {
            workspace.variables.push(Variable {
                id: name.into(),
                name: name.into(),
                value: value.into(),
                ..workspace.variables[0].clone()
            });
        }
        workspace.services[0].headers = vec![
            pair("first", service_key, "{{badSecret}}", true),
            pair("second", "x-group", "{{anotherMissingSecret}}", true),
            pair("disabled", "{{missingName}}", "{{badSecret}}", false),
        ];
        workspace.requests[0].headers = vec![
            pair("override", request_key, "new", true),
            pair("duplicate", "{{other}}", "new-again", true),
            pair("disabled", "{{missingName}}", "{{badSecret}}", false),
        ];
        let saved = store.save(workspace).unwrap();
        let mut execution = input(&saved);
        let result = store.load_for_request(&execution);
        assert!(
            result.is_ok(),
            "{service_key} <- {request_key}: {:?}",
            result.err()
        );
        execution.request.headers[0].enabled = false;
        execution.request.headers[1].enabled = false;
        assert!(
            store.load_for_request(&execution).is_err(),
            "disabled overrides cannot hide service values"
        );
    }
}

#[cfg(windows)]
#[test]
fn expanded_header_override_skips_corrupt_service_secret_with_plain_or_secret_names() {
    for secret_name in [false, true] {
        for reverse in [false, true] {
            let dir = tempdir().unwrap();
            let path = dir.path().join("expanded-header-secret.sqlite");
            legacy(&path);
            let store = Store::open(&path).unwrap();
            let mut workspace = store.load().unwrap();
            workspace.variables[0].name = "badSecret".into();
            workspace.variables[0].is_secret = true;
            workspace.variables.push(Variable {
                id: "header-name".into(),
                name: "h".into(),
                value: "x-group".into(),
                is_secret: secret_name,
                ..workspace.variables[0].clone()
            });
            workspace.services[0].headers = vec![pair(
                "service",
                if reverse { "{{h}}" } else { "X-Group" },
                "{{badSecret}}",
                true,
            )];
            workspace.requests[0].headers = vec![pair(
                "request",
                if reverse { "X-GROUP" } else { "{{h}}" },
                "new",
                true,
            )];
            let saved = store.save(workspace).unwrap();
            let db = Connection::open(&path).unwrap();
            db.execute(
                "UPDATE secret SET ciphertext=x'626164' WHERE variable_id='v'",
                [],
            )
            .unwrap();
            let execution = input(&saved);
            let result = store.load_for_request(&execution);
            assert!(
                result.is_ok(),
                "secret_name={secret_name}, reverse={reverse}: {:?}",
                result.err()
            );
            let snapshot = store.load_for_request(&execution).unwrap();
            assert_eq!(snapshot.variables[0].value, "");
            assert_eq!(snapshot.variables[1].value, "x-group");
            assert_eq!(store.load().unwrap().revision, saved.revision);
            if secret_name {
                db.execute(
                    "UPDATE secret SET ciphertext=x'626164' WHERE variable_id='header-name'",
                    [],
                )
                .unwrap();
                let mut temporary = execution.clone();
                temporary.temporary_variables = vec![pair("temp", "h", "x-group", true)];
                let snapshot = store.load_for_request(&temporary).unwrap();
                assert!(snapshot.variables.iter().all(|v| v.value.is_empty()));
            }
        }
    }
}

#[test]
fn expanded_header_override_uses_scope_and_temporary_winners_without_recursive_expansion() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("header-priority.sqlite");
    legacy(&path);
    let store = Store::open(&path).unwrap();
    let mut workspace = store.load().unwrap();
    workspace.services[0].headers = vec![pair("service", "X-Group", "{{badSecret}}", true)];
    workspace.requests[0].headers = vec![pair("request", "{{h}}", "new", true)];
    for (scope, owner) in [
        ("project", "p"),
        ("service", "s"),
        ("environment", "e"),
        ("binding", "b"),
        ("request", "r"),
    ] {
        for variable in &mut workspace.variables {
            if variable.name == "h" {
                variable.value = "wrong-lower-scope".into();
            }
        }
        workspace.variables.push(Variable {
            id: scope.into(),
            name: "h".into(),
            value: "x-group".into(),
            scope: scope.into(),
            owner_id: owner.into(),
            ..workspace.variables[0].clone()
        });
        workspace = store.save(workspace).unwrap();
        assert!(
            store.load_for_request(&input(&workspace)).is_ok(),
            "scope={scope}"
        );
    }
    let mut execution = input(&workspace);
    execution.temporary_variables = vec![pair("temp", "h", "x-group", true)];
    workspace.variables.last_mut().unwrap().value = "wrong-request-value".into();
    workspace = store.save(workspace).unwrap();
    assert!(store.load_for_request(&execution).is_ok());
    execution.temporary_variables[0].enabled = false;
    assert!(store.load_for_request(&execution).is_err());
    execution.temporary_variables[0].enabled = true;
    execution.temporary_variables[0].value = "{{token}}".into();
    workspace.variables[0].value = "x-group".into();
    store.save(workspace).unwrap();
    assert!(
        store.load_for_request(&execution).is_err(),
        "replacement values are not recursively rendered into an override"
    );
}
