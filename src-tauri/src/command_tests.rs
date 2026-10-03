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
