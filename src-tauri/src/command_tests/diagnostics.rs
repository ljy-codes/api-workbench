use super::*;
use std::time::Duration;

fn fixture(
    base: &str,
) -> (
    tempfile::TempDir,
    tauri::App<tauri::test::MockRuntime>,
    ExecuteInput,
) {
    let temp = tempfile::tempdir().unwrap();
    let store = Arc::new(store::Store::open(&temp.path().join("app.db")).unwrap());
    let workspace: Workspace = serde_json::from_value(json!({
        "revision":0, "activeProjectId":"p",
        "projects":[{"id":"p","name":"项目","activeEnvironmentId":"e"}],
        "environments":[{"id":"e","projectId":"p","name":"回环","isProduction":false}],
        "services":[{"id":"s","projectId":"p","name":"服务"}],
        "bindings":[{"id":"b","projectId":"p","serviceId":"s","environmentId":"e",
            "baseUrl":base,"enabled":true}],
        "folders":[], "variables":[{
            "id":"token","projectId":"p","scope":"project","ownerId":"p","name":"token",
            "value":"private-token","isSecret":true
        }],
        "requests":[{"id":"r","serviceId":"s","folderId":null,"name":"接口","method":"GET",
            "path":"/investigate","query":[{"id":"q","key":"token","value":"{{token}}","enabled":true}],
            "headers":[],"bodyType":"none","body":"","timeoutMs":2000}]
    })).unwrap();
    let saved = store.save(workspace).unwrap();
    let input = ExecuteInput {
        execution_id: "detailed-command".into(),
        environment_id: "e".into(),
        request: saved.requests[0].clone(),
        temporary_variables: vec![],
        production_confirmed: false,
    };
    let app = mock_builder()
        .manage(AppState {
            store,
            executions: Executions::default(),
            data_dir: temp.path().to_path_buf(),
        })
        .build(mock_context(noop_assets()))
        .unwrap();
    (temp, app, input)
}

fn assert_early_failure(
    result: models::DetailedExecutionResult,
    outcome: &str,
) -> serde_json::Value {
    let value = serde_json::to_value(result).unwrap();
    assert!(value.get("response").is_none_or(serde_json::Value::is_null));
    assert_eq!(value["diagnostics"]["outcome"], outcome, "{value}");
    assert!(value["error"]
        .as_str()
        .is_some_and(|error| !error.is_empty()));
    assert!(value["diagnostics"]["preparationMs"].is_u64());
    for key in [
        "headersMs",
        "downloadMs",
        "remoteAddress",
        "httpVersion",
        "receivedBytes",
    ] {
        assert!(value["diagnostics"].get(key).is_none(), "{key}: {value}");
    }
    for secret in ["private-token", "127.0.0.1", "http://", "DPAPI", "SQLite"] {
        assert!(!value.to_string().contains(secret), "{value}");
    }
    value
}

#[tokio::test]
async fn detailed_command_returns_diagnostics_and_cache_roundtrips_them() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (_temp, app, input) = fixture(&format!("http://{address}"));
    let handle = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut data = [0; 2048];
        let length = stream.read(&mut data).await.unwrap();
        assert!(String::from_utf8_lossy(&data[..length]).contains("private-token"));
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
            .await
            .unwrap();
    });
    let result = send_request_detailed(app.state(), input.clone()).await;
    handle.await.unwrap();
    let response = result.response.unwrap();
    assert_eq!(response.body, "ok");
    assert!(!response.url.contains("private-token"));
    assert_eq!(
        serde_json::to_value(&response.diagnostics).unwrap(),
        serde_json::to_value(&result.diagnostics).unwrap()
    );
    save_response(app.state(), "r".into(), "e".into(), response)
        .await
        .unwrap();
    let cached = load_response(app.state(), "r".into(), "e".into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(&cached.diagnostics).unwrap(),
        serde_json::to_value(&result.diagnostics).unwrap()
    );
    assert!(app
        .state::<AppState>()
        .executions
        .start(&input.execution_id)
        .is_ok());
}

#[tokio::test]
async fn detailed_command_classifies_registration_failures_and_preserves_the_running_request() {
    let (_temp, app, mut input) = fixture("http://127.0.0.1:9");
    let running = app
        .state::<AppState>()
        .executions
        .start(&input.execution_id)
        .unwrap();
    assert_early_failure(
        send_request_detailed(app.state(), input.clone()).await,
        "validation",
    );
    assert!(!running.token.is_cancelled());
    assert!(app
        .state::<AppState>()
        .executions
        .start(&input.execution_id)
        .is_err());
    drop(running);
    for id in ["", &"private-token".repeat(30)] {
        input.execution_id = id.into();
        assert_early_failure(
            send_request_detailed(app.state(), input.clone()).await,
            "validation",
        );
    }
}

#[tokio::test]
async fn detailed_command_sanitizes_store_load_failures_and_releases_execution() {
    let (temp, app, input) = fixture("http://127.0.0.1:9");
    rusqlite::Connection::open(temp.path().join("app.db"))
        .unwrap()
        .execute(
            "UPDATE secret SET ciphertext=X'010203' WHERE variable_id='token'",
            [],
        )
        .unwrap();
    assert_early_failure(
        send_request_detailed(app.state(), input.clone()).await,
        "transport",
    );
    assert!(app
        .state::<AppState>()
        .executions
        .start(&input.execution_id)
        .is_ok());
}

#[test]
fn detailed_command_deadline_and_cancellation_cover_queued_snapshot_loading() {
    for should_cancel in [false, true] {
        let (_temp, app, mut input) = fixture("http://127.0.0.1:9");
        input.request.timeout_ms = if should_cancel { 2000 } else { 100 };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .max_blocking_threads(1)
            .build()
            .unwrap();
        runtime.block_on(async {
            let (release_tx, release_rx) = std::sync::mpsc::channel();
            let (busy_tx, busy_rx) = tokio::sync::oneshot::channel();
            let blocker = tokio::task::spawn_blocking(move || {
                busy_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            });
            busy_rx.await.unwrap();
            let cancel = async {
                if should_cancel {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    cancel_request(app.state(), input.execution_id.clone()).unwrap();
                }
            };
            let (result, _) = tokio::join!(
                tokio::time::timeout(
                    Duration::from_secs(1),
                    send_request_detailed(app.state(), input.clone())
                ),
                cancel
            );
            release_tx.send(()).unwrap();
            blocker.await.unwrap();
            let value = assert_early_failure(
                result.expect("snapshot loading must share cancellation and the overall deadline"),
                if should_cancel {
                    "cancelled"
                } else {
                    "timeout"
                },
            );
            assert!(value["diagnostics"]["totalMs"].as_u64().unwrap() >= 40);
            assert!(app
                .state::<AppState>()
                .executions
                .start(&input.execution_id)
                .is_ok());
        });
    }
}

#[test]
fn detailed_command_does_not_restart_the_deadline_after_snapshot_loading() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    runtime.block_on(async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (_temp, app, mut input) =
            fixture(&format!("http://{}", listener.local_addr().unwrap()));
        input.request.timeout_ms = 240;
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 2048];
            assert!(stream.read(&mut buffer).await.unwrap() > 0);
            tokio::time::sleep(Duration::from_millis(200)).await;
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n")
                .await;
        });
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let (busy_tx, busy_rx) = tokio::sync::oneshot::channel();
        let blocker = tokio::task::spawn_blocking(move || {
            busy_tx.send(()).unwrap();
            release_rx.recv().unwrap();
        });
        busy_rx.await.unwrap();
        let release = async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            release_tx.send(()).unwrap();
        };
        let (result, _) = tokio::join!(send_request_detailed(app.state(), input), release);
        blocker.await.unwrap();
        server.abort();
        let value = serde_json::to_value(result).unwrap();
        assert_eq!(value["diagnostics"]["outcome"], "timeout", "{value}");
        assert!(value["diagnostics"]["preparationMs"].as_u64().unwrap() >= 80);
        assert!(value["diagnostics"]["headersMs"].as_u64().unwrap() >= 60);
        assert!(value["diagnostics"].get("downloadMs").is_none());
    });
}

#[tokio::test]
async fn legacy_encrypted_cache_without_diagnostics_still_loads() {
    let (temp, app, _) = fixture("http://127.0.0.1:9");
    let plaintext = json!({
        "executionId":"old","status":200,"statusText":"OK","durationMs":12,"sizeBytes":2,
        "headers":[],"body":"ok","truncated":false,"environmentName":"回环","url":"redacted"
    })
    .to_string();
    let cipher = secrets::protect(&plaintext).unwrap();
    rusqlite::Connection::open(temp.path().join("app.db"))
        .unwrap()
        .execute(
            "INSERT INTO response_cache(request_id,environment_id,project_id,ciphertext,plaintext_size,updated_order)
             VALUES ('r','e','p',?1,?2,1)",
            rusqlite::params![cipher, plaintext.len() as i64],
        )
        .unwrap();
    let response = load_response(app.state(), "r".into(), "e".into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(response.body, "ok");
    assert!(response.diagnostics.is_none());
}
