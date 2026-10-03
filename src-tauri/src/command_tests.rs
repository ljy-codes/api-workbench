use super::*;
use serde_json::json;
use tauri::test::{mock_builder, mock_context, noop_assets};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

// Exercise the same Tauri command function as the UI, not only the store API.
#[tokio::test]
async fn send_command_ignores_unrelated_corrupt_secret() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("app.db");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let store = Arc::new(store::Store::open(&path).unwrap());
    let ws: Workspace = serde_json::from_value(json!({
        "revision":0,"activeProjectId":"p",
        "projects":[{"id":"p","name":"目标","activeEnvironmentId":"e"},{"id":"other","name":"无关","activeEnvironmentId":null}],
        "environments":[{"id":"e","projectId":"p","name":"本地","isProduction":false}],
        "services":[{"id":"s","projectId":"p","name":"回环"}],
        "bindings":[{"id":"b","projectId":"p","serviceId":"s","environmentId":"e","baseUrl":format!("http://{address}"),"enabled":true}],
        "folders":[],
        "requests":[{"id":"r","serviceId":"s","folderId":null,"name":"健康检查","method":"GET","path":"/health","headers":[],"query":[],"bodyType":"none","body":"","timeoutMs":3000}],
        "variables":[{"id":"bad","projectId":"other","scope":"project","ownerId":"other","name":"token","value":"fixture-secret","isSecret":true}]
    })).unwrap();
    store.save(ws).unwrap();
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute(
            "UPDATE secret SET ciphertext=X'010203' WHERE variable_id='bad'",
            [],
        )
        .unwrap();
    let workspace = store.load().unwrap();
    let input = ExecuteInput {
        execution_id: "native-command-regression".into(),
        environment_id: "e".into(),
        request: workspace.requests[0].clone(),
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
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buffer = [0; 2048];
        let count = stream.read(&mut buffer).await.unwrap();
        assert!(String::from_utf8_lossy(&buffer[..count]).starts_with("GET /health HTTP/1.1"));
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            .await
            .unwrap();
    });
    let result = send_request(app.state(), input).await;
    if result.is_err() {
        server.abort();
    }
    assert_eq!(result.unwrap().body, "ok");
    tokio::time::timeout(std::time::Duration::from_secs(5), server)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn resolved_environment_input_drives_send_preview_export_and_response_commands() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("resolved.db");
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let store = Arc::new(store::Store::open(&path).unwrap());
    let ws: Workspace = serde_json::from_value(json!({
        "revision":0,"activeProjectId":"p",
        "projects":[{"id":"p","name":"项目","activeEnvironmentId":"e"}],
        "environments":[{"id":"e","projectId":"p","name":"A","isProduction":false}],
        "services":[{"id":"s","projectId":"p","name":"回环"}],
        "bindings":[{"id":"b","projectId":"p","serviceId":"s","environmentId":"e","baseUrl":format!("http://{address}"),"enabled":true}],
        "folders":[],
        "requests":[{"id":"r","serviceId":"s","folderId":null,"name":"接口","method":"POST","path":"/effective",
            "headers":[],"query":[],"bodyType":"text","body":"{{legacy}}","timeoutMs":3000,
            "environmentConfigs":{"e":{"headers":[],"query":[],"bodyType":"text","body":"stale-map-{{legacy}}","timeoutMs":3000}}
        }],
        "variables":[
            {"id":"bad","projectId":"p","scope":"project","ownerId":"p","name":"legacy","value":"legacy-secret","isSecret":true},
            {"id":"good","projectId":"p","scope":"project","ownerId":"p","name":"selected","value":"selected-secret","isSecret":true}
        ]
    })).unwrap();
    let saved = store.save(ws).unwrap();
    rusqlite::Connection::open(&path)
        .unwrap()
        .execute(
            "UPDATE secret SET ciphertext=X'010203' WHERE variable_id='bad'",
            [],
        )
        .unwrap();
    // The frontend has resolved/edited A. Stale map and saved legacy defaults
    // deliberately disagree: native code must never re-resolve over this draft.
    let mut request = serde_json::to_value(&saved.requests[0]).unwrap();
    request["query"] = json!([{"id":"q","key":"env","value":"resolved-a","enabled":true}]);
    request["headers"] =
        json!([{"id":"h","key":"X-Selected","value":"{{selected}}","enabled":true}]);
    request["bodyType"] = json!("form");
    request["body"] = json!("");
    request["form"] =
        json!([{"id":"f","key":"field","value":"{{selected}}","kind":"text","enabled":true}]);
    request["auth"] = json!({"kind":"bearer","token":"{{selected}}"});
    request["timeoutMs"] = json!(1000);
    let input = ExecuteInput {
        execution_id: "resolved-environment".into(),
        environment_id: "e".into(),
        request: serde_json::from_value(request).unwrap(),
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
    let preview = preview_request(app.state(), input.clone()).await.unwrap();
    assert!(preview.url.contains("env=resolved-a"));
    let curl = export_curl(app.state(), input.clone()).await.unwrap();
    assert!(curl.contains("env=resolved-a") && curl.contains("--max-time '1.000'"));
    assert!(curl.contains("field="));
    assert!(!curl.contains("legacy") && !curl.contains("selected-secret"));
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut buffer = [0; 2048];
        loop {
            let count = stream.read(&mut buffer).await.unwrap();
            assert_ne!(count, 0);
            request.extend_from_slice(&buffer[..count]);
            let text = String::from_utf8_lossy(&request);
            if let Some((headers, body)) = text.split_once("\r\n\r\n") {
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse().unwrap())
                    })
                    .unwrap();
                if body.len() >= length {
                    break;
                }
            }
        }
        let text = String::from_utf8(request).unwrap();
        assert!(text.starts_with("POST /effective?env=resolved-a HTTP/1.1"));
        assert!(text.contains("x-selected: selected-secret"));
        assert!(text.contains("authorization: Bearer selected-secret"));
        assert!(text.ends_with("field=selected-secret"));
        assert!(!text.contains("legacy"));
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
            .await
            .unwrap();
    });
    let response = send_request(app.state(), input).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), server)
        .await
        .unwrap()
        .unwrap();
    save_response(app.state(), "r".into(), "e".into(), response)
        .await
        .unwrap();
    assert_eq!(
        load_response(app.state(), "r".into(), "e".into())
            .await
            .unwrap()
            .unwrap()
            .body,
        "ok"
    );
    clear_response(app.state(), "r".into(), "e".into())
        .await
        .unwrap();
    assert!(load_response(app.state(), "r".into(), "e".into())
        .await
        .unwrap()
        .is_none());
    clear_responses(app.state()).await.unwrap();
    compact_storage(app.state()).await.unwrap();
    assert_eq!(
        app.state::<AppState>().store.load().unwrap().revision,
        saved.revision
    );
}
