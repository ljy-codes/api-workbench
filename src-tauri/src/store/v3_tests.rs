use super::*;
use serde_json::{json, Value};
use tempfile::tempdir;

fn fixture() -> Workspace {
    serde_json::from_value(json!({
        "revision":0,"activeProjectId":"p",
        "projects":[
            {"id":"p","name":"项目","activeEnvironmentId":"a","color":"#12abEF"},
            {"id":"other","name":"其他","activeEnvironmentId":null}
        ],
        "environments":[
            {"id":"a","projectId":"p","name":"A","isProduction":false,"color":"#AABBCC"},
            {"id":"b","projectId":"p","name":"B","isProduction":false},
            {"id":"foreign","projectId":"other","name":"外部","isProduction":false}
        ],
        "services":[{"id":"s","projectId":"p","name":"服务"}],
        "bindings":[{"id":"binding","projectId":"p","serviceId":"s","environmentId":"a",
                     "baseUrl":"http://127.0.0.1","enabled":true}],
        "folders":[],
        "requests":[{"id":"r","serviceId":"s","folderId":null,"name":"接口","method":"POST","path":"/",
            "query":[],"headers":[],"bodyType":"text","body":"legacy-default","timeoutMs":30000,
            "environmentConfigs":{"a":{
                "query":[{"id":"q","key":"env","value":"a","enabled":true}],
                "headers":[],"bodyType":"text","body":"env-a","timeoutMs":1000,
                "auth":{"kind":"none"},"form":[]
            }}
        }],
        "variables":[]
    })).unwrap()
}

fn data(workspace: &Workspace) -> Value {
    serde_json::to_value(workspace).unwrap()
}

#[test]
fn environment_configs_colors_roundtrip_reopen_and_legacy_defaults() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("v3.sqlite");
    let store = Store::open(&path).unwrap();
    let saved = store.save(fixture()).unwrap();
    assert_eq!(
        data(&saved)["requests"][0]["environmentConfigs"]["a"]["body"],
        "env-a"
    );
    assert_eq!(data(&saved)["projects"][0]["color"], "#12abEF");
    assert_eq!(data(&saved)["environments"][0]["color"], "#AABBCC");
    let mut edit = data(&saved);
    edit["requests"][0]["environmentConfigs"]["a"]["body"] = json!("changed-a");
    let saved = store.save(serde_json::from_value(edit).unwrap()).unwrap();
    assert_eq!(saved.requests[0].body, "legacy-default");
    drop(store);
    assert_eq!(
        data(&Store::open(&path).unwrap().load().unwrap()),
        data(&saved)
    );
}

#[test]
fn rejects_environment_config_foreign_missing_owners_colors_and_invalid_fields() {
    let dir = tempdir().unwrap();
    let store = Store::open(&dir.path().join("validation.sqlite")).unwrap();
    let saved = store.save(fixture()).unwrap();
    let mut cases = Vec::new();
    for id in ["foreign", "missing", ""] {
        let mut value = data(&saved);
        value["requests"][0]["environmentConfigs"] = json!({id: {
            "query":[],"headers":[],"bodyType":"none","body":"","timeoutMs":1000
        }});
        cases.push(value);
    }
    for field in ["projects", "environments"] {
        for color in ["", "red", "#fff", "#12345g", "#1234567", " #123456"] {
            let mut value = data(&saved);
            value[field][0]["color"] = json!(color);
            cases.push(value);
        }
    }
    for (field, bad) in [
        ("timeoutMs", json!(0)),
        ("timeoutMs", json!(u64::MAX)),
        ("bodyType", json!("invalid")),
        ("auth", json!({"kind":"bearer","token":"plaintext-secret"})),
        (
            "form",
            json!([{"id":"f","key":"k","value":"v","enabled":true,"kind":"invalid"}]),
        ),
        (
            "query",
            json!([{"id":"","key":"k","value":"v","enabled":true}]),
        ),
        (
            "headers",
            json!([
                {"id":"h","key":"k","value":"v","enabled":true},
                {"id":"h","key":"k","value":"v","enabled":true}
            ]),
        ),
    ] {
        let mut value = data(&saved);
        value["requests"][0]["environmentConfigs"]["a"][field] = bad;
        cases.push(value);
    }
    for value in cases {
        let workspace = serde_json::from_value(value).unwrap();
        assert!(store.save(workspace).is_err(), "invalid DTO accepted");
        assert_eq!(data(&store.load().unwrap()), data(&saved));
    }
}

#[test]
fn migrates_v2_with_backup_and_keeps_default_config_and_revision() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("old.sqlite");
    let db = Connection::open(&path).unwrap();
    db.execute_batch(INITIAL_SCHEMA).unwrap();
    db.execute_batch(V2_SCHEMA).unwrap();
    db.execute_batch(
        "INSERT INTO project VALUES ('p','项目',0);
         INSERT INTO environment VALUES ('a','p','A',0,0);
         INSERT INTO project_state VALUES ('p','a');
         INSERT INTO service VALUES ('s','p','服务',0,'[]','null');
         INSERT INTO request VALUES ('r','p','s',NULL,'接口','GET','/','text','old-body',30000,0,'null','[]');
         UPDATE workspace_state SET revision=9,active_project_id='p';"
    ).unwrap();
    let store = Store::open(&path).unwrap();
    let loaded = store.load().unwrap();
    assert_eq!(loaded.revision, 9);
    assert_eq!(loaded.requests[0].body, "old-body");
    assert!(data(&loaded)["requests"][0]["environmentConfigs"].is_null());
    let version: i64 = db
        .query_row("SELECT version FROM schema_migration", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 3);
    let backups: Vec<_> = std::fs::read_dir(dir.path().join("backups"))
        .unwrap()
        .collect();
    assert_eq!(backups.len(), 1);
    let backup = Connection::open(backups[0].as_ref().unwrap().path()).unwrap();
    assert_eq!(
        backup
            .query_row("SELECT version FROM schema_migration", [], |r| r
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        backup
            .query_row("SELECT body FROM request", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "old-body"
    );
    drop(store);
    Store::open(&path).unwrap();
    assert_eq!(
        std::fs::read_dir(dir.path().join("backups"))
            .unwrap()
            .count(),
        1
    );
}

fn response(body: &str) -> ResponseData {
    ResponseData {
        execution_id: "response-execution".into(),
        status: 200,
        status_text: "OK".into(),
        duration_ms: 1,
        size_bytes: body.len() as u64,
        headers: vec![Pair {
            id: "h".into(),
            key: "Set-Cookie".into(),
            value: "private-cookie".into(),
            enabled: true,
        }],
        body: body.into(),
        truncated: false,
        environment_name: "A".into(),
        url: "http://127.0.0.1".into(),
    }
}

#[test]
fn responses_encrypted_isolated_latest_reopen_and_config_save_preserves_ciphertext() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("responses.sqlite");
    let store = Store::open(&path).unwrap();
    let saved = store.save(fixture()).unwrap();
    assert!(store.load_response("r", "a").unwrap().is_none());
    store
        .save_response("r", "a", &response("private-response-a"))
        .unwrap();
    store
        .save_response("r", "b", &response("private-response-b"))
        .unwrap();
    store
        .save_response("r", "a", &response("private-response-a-latest"))
        .unwrap();
    assert_eq!(store.load().unwrap().revision, saved.revision);
    let db = Connection::open(&path).unwrap();
    let cipher: Vec<u8> = db
        .query_row(
            "SELECT ciphertext FROM response_cache WHERE environment_id='a'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let plaintext = secrets::unprotect(&cipher).unwrap();
    assert!(plaintext.contains("private-response-a-latest"));
    assert!(!cipher.windows(16).any(|w| w == b"private-response"));
    assert_eq!(
        db.query_row("SELECT count(*) FROM response_cache", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
    let saved = store.save(saved).unwrap();
    let after: Vec<u8> = db
        .query_row(
            "SELECT ciphertext FROM response_cache WHERE environment_id='a'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        cipher, after,
        "workspace save must not re-encrypt or cascade-delete"
    );
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(
        store.load_response("r", "a").unwrap().unwrap().body,
        "private-response-a-latest"
    );
    assert_eq!(
        store.load_response("r", "b").unwrap().unwrap().body,
        "private-response-b"
    );
    assert_eq!(store.load().unwrap().revision, saved.revision);
    for suffix in ["", "-wal"] {
        if let Ok(bytes) = std::fs::read(path.with_file_name(format!("responses.sqlite{suffix}"))) {
            assert!(!bytes.windows(16).any(|w| w == b"private-response"));
            assert!(!bytes.windows(14).any(|w| w == b"private-cookie"));
        }
    }
}

#[test]
fn response_ownership_clear_all_compact_and_orphan_cleanup_preserve_request_bodies() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("cleanup.sqlite");
    let store = Store::open(&path).unwrap();
    let mut saved = store.save(fixture()).unwrap();
    for (request, env) in [
        ("r", "foreign"),
        ("r", "missing"),
        ("missing", "a"),
        ("", "a"),
    ] {
        assert!(store
            .save_response(request, env, &response("secret"))
            .is_err());
        if env == "foreign" {
            assert!(store.load_response(request, env).is_err());
        } else {
            assert!(store.load_response(request, env).unwrap().is_none());
        }
        assert!(store.clear_response(request, env).is_err());
    }
    store.save_response("r", "a", &response("A")).unwrap();
    store.save_response("r", "b", &response("B")).unwrap();
    store.clear_response("r", "a").unwrap();
    store.clear_response("r", "a").unwrap();
    assert!(store.load_response("r", "a").unwrap().is_none());
    assert!(store.load_response("r", "b").unwrap().is_some());
    store.clear_responses().unwrap();
    store.compact_storage().unwrap();
    assert!(store.load_response("r", "b").unwrap().is_none());
    assert_eq!(data(&store.load().unwrap()), data(&saved));
    store.save_response("r", "a", &response("A")).unwrap();
    store.save_response("r", "b", &response("B")).unwrap();
    saved.environments.retain(|e| e.id != "b");
    let saved = store.save(saved).unwrap();
    assert!(store.load_response("r", "a").unwrap().is_some());
    let db = Connection::open(&path).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM response_cache", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    let mut invalid = saved.clone();
    invalid.active_project_id = Some("missing".into());
    assert!(store.save(invalid).is_err());
    assert!(store.load_response("r", "a").unwrap().is_some());
    let mut removed = saved;
    removed.requests.clear();
    store.save(removed).unwrap();
    assert_eq!(
        db.query_row("SELECT count(*) FROM response_cache", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn response_limits_count_serialized_bytes_and_evict_oldest_updates_not_accesses() {
    const LIMIT: usize = 8 * 1024 * 1024;
    const TOTAL: i64 = 64 * 1024 * 1024;
    let dir = tempdir().unwrap();
    let path = dir.path().join("limits.sqlite");
    let store = Store::open(&path).unwrap();
    let mut ws = fixture();
    for i in 0..10 {
        let mut request = ws.requests[0].clone();
        request.id = format!("r{i}");
        ws.requests.push(request);
    }
    store.save(ws).unwrap();
    // Do not trust sizeBytes; limit all serialized fields, including escaping.
    let mut payload = response("");
    payload.size_bytes = 0;
    let overhead = serde_json::to_vec(&payload).unwrap().len();
    payload.body = "x".repeat(LIMIT - overhead);
    assert_eq!(serde_json::to_vec(&payload).unwrap().len(), LIMIT);
    for i in 0..8 {
        store
            .save_response(&format!("r{i}"), "a", &payload)
            .unwrap();
    }
    assert!(store.load_response("r0", "a").unwrap().is_some()); // read is not refresh
    store.save_response("r0", "a", &payload).unwrap(); // update moves r0 to newest
    store.save_response("r8", "a", &payload).unwrap();
    assert!(store.load_response("r1", "a").unwrap().is_none());
    assert!(store.load_response("r0", "a").unwrap().is_some());
    assert!(store.load_response("r8", "a").unwrap().is_some());
    let db = Connection::open(&path).unwrap();
    assert_eq!(
        db.query_row("SELECT sum(plaintext_size) FROM response_cache", [], |r| {
            r.get::<_, i64>(0)
        })
        .unwrap(),
        TOTAL
    );
    payload.body.push('x');
    assert!(store.save_response("r0", "a", &payload).is_err());
    assert_eq!(
        store.load_response("r0", "a").unwrap().unwrap().body.len(),
        LIMIT - overhead
    );
    payload.body = "\0".repeat(LIMIT / 6); // escaped JSON exceeds limit
    assert!(store.save_response("r9", "a", &payload).is_err());
    payload.body.clear();
    payload.headers[0].value = "x".repeat(LIMIT);
    assert!(store.save_response("r9", "a", &payload).is_err());
    assert_eq!(
        db.query_row("SELECT count(*) FROM response_cache", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        8
    );
    let order: i64 = db
        .query_row("SELECT max(updated_order) FROM response_cache", [], |r| {
            r.get(0)
        })
        .unwrap();
    store.clear_responses().unwrap();
    drop(store);
    let store = Store::open(&path).unwrap();
    store.save_response("r", "a", &response("new")).unwrap();
    assert!(
        db.query_row("SELECT updated_order FROM response_cache", [], |r| r
            .get::<_, i64>(0))
            .unwrap()
            > order
    );
}

#[test]
fn response_cache_does_not_transfer_across_project_moves() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("move.sqlite");
    let store = Store::open(&path).unwrap();
    let mut saved = store.save(fixture()).unwrap();
    store
        .save_response("r", "a", &response("project-p-secret"))
        .unwrap();
    saved.bindings.clear();
    saved.projects[0].active_environment_id = None;
    saved.services[0].project_id = "other".into();
    saved.environments[0].project_id = "other".into();
    store.save(saved).unwrap();
    assert!(store.load_response("r", "a").unwrap().is_none());
}

#[test]
fn deleting_one_request_keeps_other_cache_and_clear_compact_reclaims_disk() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("disk.sqlite");
    let store = Store::open(&path).unwrap();
    let mut ws = fixture();
    let mut second = ws.requests[0].clone();
    second.id = "r2".into();
    ws.requests.push(second);
    let mut saved = store.save(ws).unwrap();
    store.save_response("r", "a", &response("keep")).unwrap();
    store.save_response("r2", "a", &response("remove")).unwrap();
    saved.requests.retain(|r| r.id == "r");
    let saved = store.save(saved).unwrap();
    assert_eq!(store.load_response("r", "a").unwrap().unwrap().body, "keep");
    assert!(store.load_response("r2", "a").unwrap().is_none());
    store
        .save_response("r", "a", &response(&"x".repeat(4 * 1024 * 1024)))
        .unwrap();
    store.compact_storage().unwrap();
    let before = std::fs::metadata(&path).unwrap().len();
    assert!(before > 4 * 1024 * 1024);
    store.clear_responses().unwrap();
    store.compact_storage().unwrap();
    let after = std::fs::metadata(&path).unwrap().len();
    assert!(
        before - after > 3 * 1024 * 1024,
        "before={before}, after={after}"
    );
    let wal = path.with_file_name("disk.sqlite-wal");
    assert_eq!(std::fs::metadata(wal).map(|m| m.len()).unwrap_or(0), 0);
    assert_eq!(data(&store.load().unwrap()), data(&saved));
}

#[test]
fn release_native_versions_are_1_0_0() {
    assert_eq!(env!("CARGO_PKG_VERSION"), "1.0.0");
    let config: Value = serde_json::from_str(include_str!("../../tauri.conf.json")).unwrap();
    assert_eq!(config["version"], "1.0.0");
}

#[test]
fn execution_and_external_storage_reject_foreign_environment_config_keys() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("foreign.sqlite");
    let store = Store::open(&path).unwrap();
    let saved = store.save(fixture()).unwrap();
    let mut value = data(&saved);
    value["requests"][0]["environmentConfigs"]["foreign"] =
        value["requests"][0]["environmentConfigs"]["a"].clone();
    let forged: Workspace = serde_json::from_value(value).unwrap();
    let input = ExecuteInput {
        execution_id: "foreign-config".into(),
        environment_id: "a".into(),
        request: forged.requests[0].clone(),
        temporary_variables: vec![],
        production_confirmed: false,
    };
    assert!(store.load_for_request(&input).is_err());
    assert!(crate::engine::preview(&saved, &input).is_err());
    assert!(crate::engine::export_curl(&saved, &input).is_err());
    let db = Connection::open(&path).unwrap();
    db.execute(
        "UPDATE request SET environment_configs=?1 WHERE id='r'",
        [json_value(&forged.requests[0].environment_configs).unwrap()],
    )
    .unwrap();
    assert!(store.load().is_err());
    assert!(store.save(saved).is_err());
    drop(store);
    assert!(
        Store::open(&path).is_err(),
        "external corruption must not be silently repaired"
    );
}

#[test]
fn response_corruption_is_bounded_and_cannot_break_config_save_or_manual_clear() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("corrupt-response.sqlite");
    let store = Store::open(&path).unwrap();
    let saved = store.save(fixture()).unwrap();
    store
        .save_response("r", "a", &response("private-response"))
        .unwrap();
    let db = Connection::open(&path).unwrap();
    db.execute("UPDATE response_cache SET ciphertext=X'010203'", [])
        .unwrap();
    assert!(store.load_response("r", "a").unwrap_err().contains("DPAPI"));
    let saved = store.save(saved).unwrap(); // cache ciphertext never decrypted here
    assert_eq!(data(&store.load().unwrap()), data(&saved));
    store.clear_responses().unwrap();
    store.compact_storage().unwrap();
    assert!(store.load_response("r", "a").unwrap().is_none());
    store
        .save_response("r", "a", &response("private-response"))
        .unwrap();
    db.execute("UPDATE response_cache SET plaintext_size=1", [])
        .unwrap();
    let error = store.load_response("r", "a").unwrap_err();
    assert!(!error.contains("private-response"));
    store.clear_responses().unwrap();
}

#[test]
fn response_writes_workspace_replacements_and_compaction_are_serialized() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("serialized.sqlite");
    let store = std::sync::Arc::new(Store::open(&path).unwrap());
    let saved = store.save(fixture()).unwrap();
    let writer = Store::open(&path).unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let gate = barrier.clone();
    let config = std::thread::spawn(move || {
        gate.wait();
        let mut saved = saved;
        for i in 0..8 {
            saved.requests[0].name = format!("revision-{i}");
            saved = writer.save(saved).unwrap();
        }
        saved
    });
    let cache = store.clone();
    let gate = barrier.clone();
    let responses = std::thread::spawn(move || {
        gate.wait();
        for i in 0..8 {
            cache
                .save_response("r", "a", &response(&format!("response-{i}")))
                .unwrap();
        }
    });
    barrier.wait();
    for _ in 0..3 {
        store.compact_storage().unwrap();
    }
    let saved = config.join().unwrap();
    responses.join().unwrap();
    assert_eq!(data(&store.load().unwrap()), data(&saved));
    assert_eq!(saved.revision, 9);
    assert_eq!(
        store.load_response("r", "a").unwrap().unwrap().body,
        "response-7"
    );
    assert_eq!(
        Connection::open(path)
            .unwrap()
            .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
        0
    );
}
