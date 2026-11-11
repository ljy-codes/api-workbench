use super::*;
use crate::models::TemporaryExecuteInput;
use std::time::Duration;

fn input(url: &str) -> TemporaryExecuteInput {
    serde_json::from_value(json!({
        "executionId":"temporary-command",
        "request":{"url":url,"method":"GET","query":[],"headers":[],
            "bodyType":"none","body":"","timeoutMs":2000}
    }))
    .unwrap()
}

#[tokio::test]
async fn temporary_commands_execute_with_empty_workspace_even_when_store_is_unreadable() {
    for broken_store in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("app.db");
        let store = Arc::new(store::Store::open(&path).unwrap());
        let app = mock_builder()
            .manage(AppState {
                store,
                executions: Executions::default(),
                data_dir: temp.path().to_path_buf(),
            })
            .build(mock_context(noop_assets()))
            .unwrap();
        let db = rusqlite::Connection::open(&path).unwrap();
        if broken_store {
            db.execute_batch("DROP TABLE project;").unwrap();
            assert!(app.state::<AppState>().store.load().is_err());
        }
        db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); BEGIN IMMEDIATE;")
            .unwrap();
        let before = std::fs::read(&path).unwrap();
        let before_wal = std::fs::read(path.with_extension("db-wal")).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let i = input(&format!(
            "http://{}/?token=fixture-secret",
            listener.local_addr().unwrap()
        ));
        let handle = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut buffer = [0; 2048];
            let count = stream.read(&mut buffer).await.unwrap();
            assert!(String::from_utf8_lossy(&buffer[..count]).contains("token=fixture-secret"));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")
                .await
                .unwrap();
        });
        assert!(!preview_temporary_request(i.clone())
            .unwrap()
            .url
            .contains("fixture-secret"));
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            send_temporary_request(app.state(), i.clone()),
        )
        .await
        .expect("temporary execution must not wait for Store");
        assert_eq!(result.response.unwrap().body, "ok");
        handle.await.unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(
            std::fs::read(path.with_extension("db-wal")).unwrap(),
            before_wal
        );
        assert!(app
            .state::<AppState>()
            .executions
            .start(&i.execution_id)
            .is_ok());
        db.execute_batch("ROLLBACK;").unwrap();
        if !broken_store {
            assert!(app
                .state::<AppState>()
                .store
                .load()
                .unwrap()
                .projects
                .is_empty());
            assert!(app
                .state::<AppState>()
                .store
                .load()
                .unwrap()
                .requests
                .is_empty());
        }
    }
}

#[tokio::test]
async fn temporary_commands_share_cancel_duplicate_and_cleanup_management() {
    let temp = tempfile::tempdir().unwrap();
    let app = mock_builder()
        .manage(AppState {
            store: Arc::new(store::Store::open(&temp.path().join("app.db")).unwrap()),
            executions: Executions::default(),
            data_dir: temp.path().to_path_buf(),
        })
        .build(mock_context(noop_assets()))
        .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let i = input(&format!("http://{}/", listener.local_addr().unwrap()));
    let registry = app.state::<AppState>().executions.clone();
    let held = registry.start(&i.execution_id).unwrap();
    let duplicate = send_temporary_request(app.state(), i.clone()).await;
    assert_eq!(
        serde_json::to_value(duplicate).unwrap()["diagnostics"]["outcome"],
        "validation"
    );
    assert!(!held.token.is_cancelled());
    drop(held);
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut buffer = [0; 2048];
        stream.read(&mut buffer).await.unwrap();
        let _ = ready_tx.send(());
        tokio::time::sleep(Duration::from_secs(5)).await;
    });
    let future = send_temporary_request(app.state(), i.clone());
    let task = tokio::spawn(future);
    ready_rx.await.unwrap();
    cancel_request(app.state(), i.execution_id.clone()).unwrap();
    let result = tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(result).unwrap()["diagnostics"]["outcome"],
        "cancelled"
    );
    assert!(registry.start(&i.execution_id).is_ok());
    server.abort();
}
