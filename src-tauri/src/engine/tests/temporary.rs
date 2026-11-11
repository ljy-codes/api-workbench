use super::*;
use crate::models::{AuthConfig, FormField, TemporaryExecuteInput};

fn input(url: &str) -> TemporaryExecuteInput {
    serde_json::from_value(json!({
        "executionId":"temporary-test",
        "request":{"url":url,"method":"GET","query":[],"headers":[],
            "bodyType":"none","body":"","timeoutMs":2000}
    }))
    .unwrap()
}

fn field(key: &str, value: &str, kind: &str) -> FormField {
    serde_json::from_value(json!({
        "id":key,"key":key,"value":value,"kind":kind,"enabled":true
    }))
    .unwrap()
}

fn outcome(result: &DetailedExecutionResult) -> String {
    serde_json::to_value(result).unwrap()["diagnostics"]["outcome"]
        .as_str()
        .unwrap()
        .into()
}

#[test]
fn temporary_preview_preserves_existing_query_bytes_duplicates_and_masks_secrets() {
    let mut i = input(
        "https://example.test/a%2fb//c?tag=a%20b&tag=a+b&raw=%2f&flag&access%5ftoken=private-url",
    );
    i.request.query = vec![
        pair("tag", "a%2Fb"),
        pair("tag", "a/b"),
        pair("password", "private-query"),
    ];
    let p = preview_temporary(&i).unwrap();
    assert_eq!(p.url, "https://example.test/a%2fb//c?tag=a%20b&tag=a+b&raw=%2f&flag&access%5ftoken=%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2&tag=a%252Fb&tag=a%2Fb&password=%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2");
    assert_eq!(p.environment_name, "无环境");
    assert!(p.resolved_variables.is_empty());
    assert!(!p.is_production);
    let encoded = serde_json::to_value(&i).unwrap();
    assert_eq!(encoded["request"]["timeoutMs"], 2000);
    assert!(encoded["request"].get("timeout_ms").is_none());
    assert!(i.request.auth.is_none());
    assert!(i.request.form.is_empty());
}

#[test]
fn temporary_rejects_ambiguous_and_invalid_urls_without_echoing_input() {
    for url in [
        "",
        "/private-input",
        "//example.test/private-input",
        "ftp://example.test/private-input",
        "file:///private-input",
        "http:example.test/private-input",
        "http:///private-input",
        "http://user:private-input@example.test/",
        "http://@example.test/private-input",
        "http://example.test\\private-input",
        "http://example.test/#private-input",
        " http://example.test/private-input",
        "http://example.test/private-input ",
        "http://example.test/private-input\n",
        "http://example.test/%0d%0aprivate-input",
        "http://example.test/private-input%",
        "http://example.test/?q=private-input%zz",
        "http://example.test/../private-input",
        "http://example.test/%2e%2e/private-input",
        "http://example.test/%5cprivate-input",
        "http://:80/private-input",
        "http://example.test:/private-input",
        "http://127.1/private-input",
        "http://0x7f000001/private-input",
        "http://2130706433/private-input",
        "http://%65xample.test/private-input",
    ] {
        let error = preview_temporary(&input(url)).expect_err("unsafe URL accepted");
        assert!(!error.contains("private-input"), "{error}");
    }
    for url in [
        "http://localhost/",
        "HTTPS://EXAMPLE.TEST:443/a",
        "http://[::1]:8080/a",
        "https://example.test/中文?q=a%20b",
    ] {
        assert!(preview_temporary(&input(url)).is_ok(), "{url}");
    }
}

#[tokio::test]
async fn temporary_sends_literal_json_headers_and_encoded_query_without_environment() {
    let (base, rx, handle) = server(
        "422 Unprocessable Entity",
        "",
        b"ok".to_vec(),
        Duration::ZERO,
    )
    .await;
    let mut i = input(&format!("{base}/a%2fb?tag=a%20b&tag=a+b&token=private-url"));
    i.request.method = "POST".into();
    i.request.query = vec![pair("tag", "a%2Fb"), pair("tag", "{{literal}}")];
    i.request.headers = vec![
        pair("x-repeat", "one"),
        pair("x-repeat", "two"),
        pair("x-literal", "{{literal}}"),
    ];
    i.request.body_type = "json".into();
    i.request.body = r#"{"{{key}}":"{{missing}}","nested":["{{other}}",true,2]}"#.into();
    let result = execute_temporary_detailed(i, CancellationToken::new()).await;
    assert_eq!(outcome(&result), "response", "{result:?}");
    let response = result.response.unwrap();
    let wire = String::from_utf8(rx.await.unwrap()).unwrap();
    assert!(wire.starts_with("POST /gateway/a%2fb?tag=a%20b&tag=a+b&token=private-url&tag=a%252Fb&tag=%7B%7Bliteral%7D%7D HTTP/1.1\r\n"), "{wire}");
    assert!(wire.contains("x-repeat: one\r\nx-repeat: two\r\n"));
    assert!(wire.contains("x-literal: {{literal}}\r\n"));
    assert!(wire.contains("content-type: application/json\r\n"));
    let body: Value = serde_json::from_str(wire.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(body["{{key}}"], "{{missing}}");
    assert_eq!(body["nested"][0], "{{other}}");
    assert_eq!(response.status, 422);
    assert_eq!(response.body, "ok");
    assert!(!response.url.contains("private-url"));
    assert_eq!(response.environment_name, "无环境");
    handle.await.unwrap();
}

#[tokio::test]
async fn temporary_auth_sends_direct_credentials_and_redacts_custom_query_keys() {
    for (config, expected) in [
        (
            json!({"kind":"bearer","token":"direct-secret"}),
            "authorization: Bearer direct-secret\r\n",
        ),
        (
            json!({"kind":"basic","username":"user","password":"direct-secret"}),
            "authorization: Basic dXNlcjpkaXJlY3Qtc2VjcmV0\r\n",
        ),
        (
            json!({"kind":"apiKey","key":"x-custom","value":"direct-secret","location":"header"}),
            "x-custom: direct-secret\r\n",
        ),
        (
            json!({"kind":"apiKey","key":"custom","value":"direct-secret","location":"query"}),
            "?custom=direct-secret HTTP/1.1\r\n",
        ),
        (
            json!({"kind":"bearer","token":"{{literal}}"}),
            "authorization: Bearer {{literal}}\r\n",
        ),
    ] {
        let (base, rx, handle) = server("200 OK", "", vec![], Duration::ZERO).await;
        let mut i = input(&base);
        i.request.auth = Some(serde_json::from_value(config).unwrap());
        let preview = preview_temporary(&i).unwrap();
        assert!(!serde_json::to_string(&preview)
            .unwrap()
            .contains("direct-secret"));
        let result = execute_temporary_detailed(i, CancellationToken::new()).await;
        assert_eq!(outcome(&result), "response", "{result:?}");
        assert!(!result.response.unwrap().url.contains("direct-secret"));
        assert!(
            String::from_utf8(rx.await.unwrap())
                .unwrap()
                .contains(expected),
            "{expected}"
        );
        handle.await.unwrap();
    }
}

#[test]
fn temporary_validates_headers_auth_body_and_ids_before_transport() {
    let valid = input("https://example.test/");
    let auth_cases = [
        json!({"kind":"bearer","token":"private-input\r\ninjected: yes"}),
        json!({"kind":"basic","username":"a:b","password":"private-input"}),
        json!({"kind":"apiKey","key":"Host","value":"private-input","location":"header"}),
        json!({"kind":"apiKey","key":"x","value":"private-input","location":"invalid"}),
        json!({"kind":"unknown","token":"private-input"}),
        json!({"kind":"none","location":"invalid"}),
    ];
    for config in auth_cases {
        let mut i = valid.clone();
        i.request.auth = Some(serde_json::from_value::<AuthConfig>(config).unwrap());
        let error = preview_temporary(&i).unwrap_err();
        assert!(!error.contains("private-input"));
    }
    for case in 0..16 {
        let mut i = valid.clone();
        match case {
            0 => i.execution_id.clear(),
            1 => i.execution_id = " ".into(),
            2 => i.execution_id = "x".repeat(201),
            3 => i.request.timeout_ms = 0,
            4 => i.request.timeout_ms = 300_001,
            5 => i.request.method = "CONNECT".into(),
            6 => i.request.method = "bad method".into(),
            7 => i.request.headers = vec![pair("Host", "private-input")],
            8 => i.request.headers = vec![pair("x", "private-input\r\nx: y")],
            9 => {
                i.request.body_type = "json".into();
                i.request.body = "{bad".into();
            }
            10 => {
                i.request.body_type = "multipart".into();
                i.request.headers = vec![pair("Content-Type", "manual")];
            }
            11 => {
                i.request.body_type = "form".into();
                i.request.form = vec![field("f", "private-input", "file")];
            }
            12 => {
                i.request.body_type = "multipart".into();
                i.request.form = vec![field("bad\r\nname", "private-input", "text")];
            }
            13 => {
                i.request.auth = Some(
                    serde_json::from_value(json!({"kind":"bearer","token":"private-input"}))
                        .unwrap(),
                );
                i.request.headers = vec![pair("Authorization", "manual")];
            }
            14 => {
                i.request.url.push_str("?custom=manual");
                i.request.auth = Some(serde_json::from_value(json!({"kind":"apiKey","key":"custom","value":"private-input","location":"query"})).unwrap());
            }
            _ => i.request.body_type = "unknown".into(),
        }
        let error = preview_temporary(&i).expect_err(&format!("case {case}"));
        assert!(!error.contains("private-input"));
    }
}

#[tokio::test]
async fn temporary_text_form_and_multipart_send_literal_values_and_file_bytes() {
    let temp = tempfile::tempdir().unwrap();
    let file = temp.path().join("fixture.txt");
    std::fs::write(&file, "file-content").unwrap();
    for kind in ["text", "form", "multipart"] {
        let (base, rx, handle) = server("200 OK", "", vec![], Duration::ZERO).await;
        let mut i = input(&base);
        i.request.method = "PUT".into();
        i.request.body_type = kind.into();
        i.request.body = "{{literal}}".into();
        i.request.form = vec![
            field("tag", "a &+中", "text"),
            field("tag", "{{literal}}", "text"),
        ];
        if kind == "multipart" {
            i.request
                .form
                .push(field("upload", file.to_str().unwrap(), "file"));
        }
        assert!(preview_temporary(&i).is_ok());
        let result = execute_temporary_detailed(i, CancellationToken::new()).await;
        assert_eq!(outcome(&result), "response", "{result:?}");
        let wire = String::from_utf8(rx.await.unwrap()).unwrap();
        match kind {
            "text" => assert!(wire.ends_with("{{literal}}")),
            "form" => {
                assert!(wire.contains("content-type: application/x-www-form-urlencoded\r\n"));
                assert!(wire.ends_with("tag=a+%26%2B%E4%B8%AD&tag=%7B%7Bliteral%7D%7D"));
            }
            _ => {
                assert!(wire.contains("content-type: multipart/form-data; boundary="));
                assert_eq!(wire.matches("name=\"tag\"").count(), 2);
                assert!(wire.contains("{{literal}}"));
                assert!(wire.contains("filename=\"fixture.txt\""));
                assert!(wire.contains("file-content"));
                assert!(!wire.contains(temp.path().to_str().unwrap()));
            }
        }
        handle.await.unwrap();
    }
    let mut i = input("http://127.0.0.1:9/");
    i.request.body_type = "multipart".into();
    i.request.form = vec![field("f", "missing-private-file", "file")];
    assert!(
        preview_temporary(&i).is_ok(),
        "preview must not access files"
    );
    let result = execute_temporary_detailed(i, CancellationToken::new()).await;
    assert_eq!(outcome(&result), "validation");
    assert!(!serde_json::to_string(&result)
        .unwrap()
        .contains("missing-private-file"));
}

#[tokio::test]
async fn temporary_timeout_and_cancellation_interrupt_headers_and_body() {
    for body_started in [false, true] {
        for should_cancel in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut i = input(&format!(
                "http://{}/?token=private-input",
                listener.local_addr().unwrap()
            ));
            i.request.timeout_ms = if should_cancel { 2000 } else { 140 };
            let (ready_tx, ready_rx) = oneshot::channel();
            let handle = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                read_request(&mut stream).await;
                if body_started {
                    stream
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nabc")
                        .await
                        .unwrap();
                }
                let _ = ready_tx.send(());
                tokio::time::sleep(Duration::from_secs(5)).await;
            });
            let cancel = CancellationToken::new();
            let token = cancel.clone();
            let task = tokio::spawn(async move { execute_temporary_detailed(i, token).await });
            ready_rx.await.unwrap();
            if should_cancel {
                tokio::time::sleep(Duration::from_millis(30)).await;
                cancel.cancel();
            }
            let result = tokio::time::timeout(Duration::from_secs(2), task)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(
                outcome(&result),
                if should_cancel {
                    "cancelled"
                } else {
                    "timeout"
                }
            );
            assert!(result.response.is_none());
            assert!(!serde_json::to_string(&result)
                .unwrap()
                .contains("private-input"));
            if body_started {
                assert_eq!(result.diagnostics.received_bytes, Some(3));
                assert!(result.diagnostics.download_ms.is_some());
            }
            handle.abort();
        }
    }
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert_eq!(
        outcome(&execute_temporary_detailed(input("http://127.0.0.1:9/"), cancel).await),
        "cancelled"
    );
}

#[tokio::test]
async fn temporary_reuses_response_limit_and_never_follows_redirects() {
    let limit = 2 * 1024 * 1024;
    let (base, _, handle) = server("200 OK", "", vec![b'x'; limit + 8192], Duration::ZERO).await;
    let result = execute_temporary_detailed(input(&base), CancellationToken::new()).await;
    let response = result.response.unwrap();
    assert_eq!(response.body.len(), limit);
    assert!(response.truncated);
    assert!(response.size_bytes > limit as u64);
    handle.await.unwrap();
    let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let location = format!(
        "Location: http://{}/redirect\r\n",
        target.local_addr().unwrap()
    );
    let (base, _, handle) =
        server("307 Temporary Redirect", &location, vec![], Duration::ZERO).await;
    let mut i = input(&base);
    i.request.method = "POST".into();
    let response = execute_temporary_detailed(i, CancellationToken::new())
        .await
        .response
        .unwrap();
    assert_eq!(response.status, 307);
    assert!(
        tokio::time::timeout(Duration::from_millis(100), target.accept())
            .await
            .is_err()
    );
    handle.await.unwrap();
}

#[tokio::test]
async fn temporary_validation_and_connection_errors_never_echo_url_body_or_credentials() {
    for case in 0..2 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut i = input(&format!(
            "http://{}/private-path?token=private-input",
            listener.local_addr().unwrap()
        ));
        drop(listener);
        // Windows can take about two seconds to return WSAECONNREFUSED.
        i.request.timeout_ms = 10_000;
        i.request.auth =
            Some(serde_json::from_value(json!({"kind":"bearer","token":"private-auth"})).unwrap());
        if case == 0 {
            i.request.body_type = "json".into();
            i.request.body = "private-body".into();
        }
        let result = execute_temporary_detailed(i, CancellationToken::new()).await;
        assert_eq!(
            outcome(&result),
            if case == 0 {
                "validation"
            } else {
                "connection"
            }
        );
        let text = serde_json::to_string(&result).unwrap();
        for secret in [
            "private-input",
            "private-auth",
            "private-body",
            "private-path",
            "http://",
        ] {
            assert!(!text.contains(secret), "{text}");
        }
    }
}
