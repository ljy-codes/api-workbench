use super::*;

#[tokio::test]
async fn legacy_execution_attaches_real_response_diagnostics() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        read_request(&mut stream).await;
        tokio::time::sleep(Duration::from_millis(35)).await;
        stream
            .write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 3\r\n\r\n")
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(75)).await;
        stream.write_all(b"abc").await.unwrap();
    });
    let (mut workspace, input) = fixture();
    workspace.bindings[0].base_url = format!("http://{address}");
    let response = execute(&workspace, input, CancellationToken::new())
        .await
        .unwrap();
    handle.await.unwrap();
    let value = serde_json::to_value(response).unwrap();
    assert_eq!(value["status"], 503);
    let diagnostics = &value["diagnostics"];
    assert_eq!(diagnostics["outcome"], "response");
    assert!(diagnostics["totalMs"].as_u64().unwrap() >= 100);
    assert!(diagnostics["preparationMs"].is_u64());
    assert!(diagnostics["headersMs"].as_u64().unwrap() >= 30);
    assert!(diagnostics["downloadMs"].as_u64().unwrap() >= 65);
    assert_eq!(diagnostics["remoteAddress"], address.to_string());
    assert_eq!(diagnostics["httpVersion"], "HTTP/1.1");
    assert_eq!(diagnostics["receivedBytes"], 3);
    assert_eq!(diagnostics["totalMs"], value["durationMs"]);
    let stages = ["preparationMs", "headersMs", "downloadMs"]
        .iter()
        .map(|key| diagnostics[key].as_u64().unwrap())
        .sum::<u64>();
    assert!(diagnostics["totalMs"].as_u64().unwrap() >= stages);
}

fn failure_value(result: crate::models::DetailedExecutionResult, outcome: &str) -> Value {
    let value = serde_json::to_value(result).unwrap();
    assert!(value.get("response").is_none_or(Value::is_null));
    assert_eq!(value["diagnostics"]["outcome"], outcome, "{value}");
    assert!(value["error"]
        .as_str()
        .is_some_and(|error| !error.is_empty()));
    assert!(value["diagnostics"]["totalMs"].is_u64());
    for secret in ["private-token", "127.0.0.1", "http://", "reqwest"] {
        assert!(!value.to_string().contains(secret), "{value}");
    }
    value
}

fn no_download(value: &Value) {
    for field in [
        "downloadMs",
        "remoteAddress",
        "httpVersion",
        "receivedBytes",
    ] {
        assert!(
            value["diagnostics"].get(field).is_none(),
            "{field}: {value}"
        );
    }
}

#[tokio::test]
async fn detailed_connection_failure_keeps_attempt_timing_without_fake_body_metrics() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let (mut workspace, mut input) = fixture();
    // Windows may retry a refused SYN for about two seconds before returning
    // WSAECONNREFUSED. Leave room to observe connection failure, not our deadline.
    input.request.timeout_ms = 10_000;
    workspace.bindings[0].base_url = format!("http://{address}");
    input.request.path = "/private-token".into();
    input.request.query = vec![pair("token", "private-token")];
    let value = failure_value(
        execute_detailed(&workspace, input, CancellationToken::new()).await,
        "connection",
    );
    assert!(value["diagnostics"]["preparationMs"].is_u64());
    assert!(value["diagnostics"]["headersMs"].is_u64());
    no_download(&value);
}

#[tokio::test]
async fn detailed_validation_and_upload_errors_have_no_network_metrics_or_secrets() {
    let temp = tempfile::tempdir().unwrap();
    for case in 0..5 {
        let (mut workspace, mut input) = fixture();
        match case {
            0 => input.request.path = "/{{private-token}}".into(),
            1 => workspace.environments[0].is_production = true,
            2 => input.request.timeout_ms = 0,
            3 => input.request.timeout_ms = u64::MAX,
            _ => {
                input.request.body_type = "multipart".into();
                input.request.form = serde_json::from_value(json!([{
                    "id":"file", "key":"upload", "kind":"file", "enabled":true,
                    "value":temp.path().join("private-token.bin").to_str().unwrap()
                }]))
                .unwrap();
            }
        }
        let value = failure_value(
            execute_detailed(&workspace, input, CancellationToken::new()).await,
            "validation",
        );
        assert!(value["diagnostics"]["preparationMs"].is_u64());
        assert!(value["diagnostics"].get("headersMs").is_none());
        no_download(&value);
    }
}

#[tokio::test]
async fn detailed_precancelled_execution_has_no_invented_phase_measurements() {
    let (workspace, input) = fixture();
    let cancel = CancellationToken::new();
    cancel.cancel();
    let value = failure_value(
        execute_detailed(&workspace, input, cancel).await,
        "cancelled",
    );
    assert!(value["diagnostics"].get("preparationMs").is_none());
    assert!(value["diagnostics"].get("headersMs").is_none());
    no_download(&value);
}

#[tokio::test]
async fn detailed_header_timeout_and_cancellation_measure_only_the_started_phases() {
    for should_cancel in [false, true] {
        let (base, request_rx, server) = server("200 OK", "", vec![], Duration::from_secs(5)).await;
        let (mut workspace, mut input) = fixture();
        workspace.bindings[0].base_url = base;
        input.request.path = "/private-token".into();
        input.request.timeout_ms = if should_cancel { 2000 } else { 140 };
        let cancel = CancellationToken::new();
        let token = cancel.clone();
        let task = tokio::spawn(async move { execute_detailed(&workspace, input, token).await });
        request_rx.await.unwrap();
        if should_cancel {
            tokio::time::sleep(Duration::from_millis(45)).await;
            cancel.cancel();
        }
        let result = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
        server.abort();
        let value = failure_value(
            result,
            if should_cancel {
                "cancelled"
            } else {
                "timeout"
            },
        );
        assert!(value["diagnostics"]["headersMs"].as_u64().unwrap() >= 35);
        assert!(value["diagnostics"]["preparationMs"].is_u64());
        no_download(&value);
    }
}

#[tokio::test]
async fn detailed_body_failure_timeout_and_cancel_preserve_received_bytes_and_metadata() {
    for outcome in ["body", "timeout", "cancelled"] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (body_tx, body_rx) = oneshot::channel();
        let handle = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_request(&mut stream).await;
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nabc")
                .await
                .unwrap();
            let _ = body_tx.send(());
            tokio::time::sleep(Duration::from_millis(if outcome == "body" {
                60
            } else {
                5000
            }))
            .await;
        });
        let (mut workspace, mut input) = fixture();
        workspace.bindings[0].base_url = format!("http://{address}");
        input.request.path = "/private-token".into();
        input.request.timeout_ms = if outcome == "timeout" { 180 } else { 2000 };
        let cancel = CancellationToken::new();
        let token = cancel.clone();
        let task = tokio::spawn(async move { execute_detailed(&workspace, input, token).await });
        body_rx.await.unwrap();
        if outcome == "cancelled" {
            tokio::time::sleep(Duration::from_millis(60)).await;
            cancel.cancel();
        }
        let result = tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .unwrap()
            .unwrap();
        handle.abort();
        let value = serde_json::to_value(&result).unwrap();
        assert!(value.get("response").is_none_or(Value::is_null));
        assert_eq!(value["diagnostics"]["outcome"], outcome, "{value}");
        assert!(!value["error"].as_str().unwrap().contains("private-token"));
        assert!(!value["error"].as_str().unwrap().contains("http"));
        assert!(value["diagnostics"]["headersMs"].is_u64());
        assert!(value["diagnostics"]["downloadMs"].as_u64().unwrap() >= 45);
        assert_eq!(value["diagnostics"]["receivedBytes"], 3);
        assert_eq!(value["diagnostics"]["remoteAddress"], address.to_string());
        assert_eq!(value["diagnostics"]["httpVersion"], "HTTP/1.1");
    }
}

#[tokio::test]
async fn detailed_invalid_http_response_is_safe_transport_failure() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        read_request(&mut stream).await;
        stream
            .write_all(b"private-token is not HTTP\r\n\r\n")
            .await
            .unwrap();
    });
    let (mut workspace, mut input) = fixture();
    workspace.bindings[0].base_url = format!("http://{address}");
    input.request.path = "/private-token".into();
    let value = failure_value(
        execute_detailed(&workspace, input, CancellationToken::new()).await,
        "transport",
    );
    handle.await.unwrap();
    assert!(value["diagnostics"]["headersMs"].is_u64());
    no_download(&value);
}

#[tokio::test]
async fn detailed_truncated_response_counts_received_bytes_and_copies_diagnostics() {
    const LIMIT: usize = 2 * 1024 * 1024;
    let (base, _, handle) = server("200 OK", "", vec![b'x'; LIMIT + 37], Duration::ZERO).await;
    let (mut workspace, input) = fixture();
    workspace.bindings[0].base_url = base;
    let result = execute_detailed(&workspace, input, CancellationToken::new()).await;
    handle.await.unwrap();
    let value = serde_json::to_value(result).unwrap();
    assert!(value.get("error").is_none_or(Value::is_null));
    assert_eq!(value["diagnostics"]["outcome"], "response");
    assert_eq!(value["response"]["truncated"], true);
    assert_eq!(value["response"]["body"].as_str().unwrap().len(), LIMIT);
    assert_eq!(
        value["diagnostics"]["receivedBytes"],
        value["response"]["sizeBytes"]
    );
    assert!(value["diagnostics"]["receivedBytes"].as_u64().unwrap() > LIMIT as u64);
    assert_eq!(value["response"]["diagnostics"], value["diagnostics"]);
}
