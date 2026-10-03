//! All transport tests bind loopback; no external HTTP service is used.
use super::*;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

fn fixture() -> (Workspace, ExecuteInput) {
    let request = json!({
        "id":"r", "serviceId":"s", "folderId":null, "name":"Request",
        "method":"GET", "path":"/users", "query":[], "headers":[],
        "bodyType":"none", "body":"", "timeoutMs":2000
    });
    let workspace = json!({
        "revision":0, "activeProjectId":"p",
        "projects":[{"id":"p","name":"Project","activeEnvironmentId":"e"}],
        "environments":[{"id":"e","projectId":"p","name":"Local","isProduction":false},
                        {"id":"e2","projectId":"p","name":"Second","isProduction":false}],
        "services":[{"id":"s","projectId":"p","name":"Service"}],
        "bindings":[{"id":"b","projectId":"p","serviceId":"s","environmentId":"e",
                     "baseUrl":"http://127.0.0.1:9/gateway","enabled":true},
                    {"id":"b2","projectId":"p","serviceId":"s","environmentId":"e2",
                     "baseUrl":"http://127.0.0.1:9/second","enabled":true}],
        "folders":[], "requests":[request.clone()], "variables":[]
    });
    let input = json!({
        "executionId":"run-1", "environmentId":"e", "request":request,
        "temporaryVariables":[], "productionConfirmed":false
    });
    (
        serde_json::from_value(workspace).unwrap(),
        serde_json::from_value(input).unwrap(),
    )
}

fn pair(key: &str, value: &str) -> crate::models::Pair {
    serde_json::from_value(json!({"id":key,"key":key,"value":value,"enabled":true})).unwrap()
}

fn variable(scope: &str, owner: &str, name: &str, value: &str, secret: bool) -> Value {
    json!({"id":format!("{scope}-{name}"),"projectId":"p","scope":scope,
        "ownerId":owner,"name":name,"value":value,"isSecret":secret})
}

fn set_variables(workspace: &mut Workspace, variables: Vec<Value>) {
    workspace.variables = serde_json::from_value(json!(variables)).unwrap();
}

mod v02;

#[test]
fn keeps_gateway_prefix_and_switches_environment_without_fallback() {
    let (workspace, mut input) = fixture();
    assert_eq!(
        preview(&workspace, &input).unwrap().url,
        "http://127.0.0.1:9/gateway/users"
    );
    input.environment_id = "e2".into();
    let result = preview(&workspace, &input).unwrap();
    assert_eq!(result.url, "http://127.0.0.1:9/second/users");
    assert_eq!(result.environment_name, "Second");
}

#[test]
fn rejects_missing_disabled_empty_and_ambiguous_bindings() {
    for case in 0..4 {
        let (mut workspace, input) = fixture();
        match case {
            0 => workspace.bindings.clear(),
            1 => workspace.bindings[0].enabled = false,
            2 => workspace.bindings[0].base_url.clear(),
            _ => workspace.bindings.push(workspace.bindings[0].clone()),
        }
        assert!(preview(&workspace, &input).is_err(), "case {case}");
    }
}

#[test]
fn rejects_cross_project_and_forged_request_relationships() {
    for case in 0..8 {
        let (mut workspace, mut input) = fixture();
        match case {
            0 => workspace.environments[0].project_id = "other".into(),
            1 => workspace.services[0].project_id = "other".into(),
            2 => workspace.bindings[0].project_id = "other".into(),
            3 => input.request.service_id = "missing".into(),
            4 => input.request.id = "unsaved".into(),
            5 => workspace.requests[0].service_id = "other".into(),
            6 => workspace.active_project_id = Some("other".into()),
            _ => input.request.folder_id = Some("missing".into()),
        }
        assert!(preview(&workspace, &input).is_err(), "case {case}");
    }
}

#[test]
fn all_six_layers_override_in_order_and_empty_is_defined() {
    let (mut workspace, mut input) = fixture();
    input.request.query = vec![pair("value", "{{v}}")];
    let scopes = [
        ("project", "p"),
        ("service", "s"),
        ("environment", "e"),
        ("binding", "b"),
        ("request", "r"),
    ];
    let mut definitions = Vec::new();
    for (scope, owner) in scopes {
        definitions.push(variable(scope, owner, "v", scope, false));
        set_variables(&mut workspace, definitions.clone());
        let result = preview(&workspace, &input).unwrap();
        assert!(result.url.ends_with(&format!("value={scope}")));
        let resolved = serde_json::to_value(result.resolved_variables).unwrap();
        assert_eq!(resolved[0]["source"], scope);
    }
    input.temporary_variables.push(pair("v", ""));
    assert!(preview(&workspace, &input).unwrap().url.ends_with("value="));
    input.temporary_variables[0].enabled = false;
    assert!(preview(&workspace, &input)
        .unwrap()
        .url
        .ends_with("value=request"));
}

#[test]
fn unrelated_scopes_never_supply_a_missing_variable() {
    let (mut workspace, mut input) = fixture();
    input.request.path = "/{{v}}".into();
    set_variables(
        &mut workspace,
        vec![variable("environment", "e2", "v", "wrong", false)],
    );
    assert!(preview(&workspace, &input).is_err());
    workspace.variables[0].owner_id = "e".into();
    workspace.variables[0].project_id = "other".into();
    assert!(preview(&workspace, &input).is_err());
}

#[test]
fn non_recursive_replacement_uses_original_tokens_only() {
    let (mut workspace, mut input) = fixture();
    set_variables(
        &mut workspace,
        vec![variable("project", "p", "v", "{{missing}}", false)],
    );
    input.request.path = "/{{v}}/{{v}}".into();
    assert!(preview(&workspace, &input)
        .unwrap()
        .url
        .ends_with("/%7B%7Bmissing%7D%7D/%7B%7Bmissing%7D%7D"));
}

#[test]
fn secret_preview_and_temporary_override_remain_masked() {
    let (mut workspace, mut input) = fixture();
    set_variables(
        &mut workspace,
        vec![variable("project", "p", "v", "top/secret", true)],
    );
    input.request.path = "/{{v}}".into();
    input.request.query = vec![pair("q", "{{v}}")];
    let result = preview(&workspace, &input).unwrap();
    let serialized = serde_json::to_string(&result).unwrap();
    assert!(!serialized.contains("top"));
    let values = serde_json::to_value(result.resolved_variables).unwrap();
    assert_eq!(values[0]["value"], "••••••");
    assert_eq!(values[0]["isSecret"], true);
    input
        .temporary_variables
        .push(pair("v", "temporary-secret"));
    assert!(
        !serde_json::to_string(&preview(&workspace, &input).unwrap())
            .unwrap()
            .contains("temporary-secret")
    );
}

#[test]
fn preview_uses_secret_flags_when_store_has_removed_secret_values() {
    let (mut workspace, mut input) = fixture();
    // Store::load returns an empty value for this secret. Treating it as the
    // actual path value would incorrectly turn the segment into ".".
    set_variables(
        &mut workspace,
        vec![variable("project", "p", "suffix", "", true)],
    );
    input.request.path = "/.{{suffix}}".into();
    let preview = preview(&workspace, &input).expect("preview must not require decryption");
    assert!(preview.url.contains("%E2%80%A2"));
}

#[test]
fn preview_secret_header_names_do_not_require_the_decrypted_name() {
    let (mut workspace, mut input) = fixture();
    set_variables(
        &mut workspace,
        vec![variable("project", "p", "header", "", true)],
    );
    input.request.headers = vec![pair("{{header}}", "value")];
    assert!(preview(&workspace, &input).is_ok());
}

#[test]
fn path_encoding_preserves_static_escapes_and_internal_double_slashes() {
    let (workspace, mut input) = fixture();
    input.request.path = "/files//a%20b/{{id}}".into();
    input.temporary_variables = vec![pair("id", "a/b?c#d%20e")];
    assert_eq!(
        preview(&workspace, &input).unwrap().url,
        "http://127.0.0.1:9/gateway/files//a%20b/a%2Fb%3Fc%23d%2520e"
    );
}

#[test]
fn rejects_unsafe_path_shapes_before_url_normalization() {
    let (workspace, mut input) = fixture();
    for path in [
        "//attacker/x",
        "https://attacker/x",
        "http:evil",
        "/../x",
        "/./x",
        "/%2e%2e/x",
        "/.%2E/x",
        "/%2e/x",
        "/a\\b",
        "/a%5Cb",
        "/a?x=1",
        "/a#f",
        "/bad%",
        "/bad%2",
        "/bad%ZZ",
        "/a\nb",
    ] {
        input.request.path = path.into();
        assert!(preview(&workspace, &input).is_err(), "accepted {path}");
    }
    input.request.path = "/{{id}}".into();
    for value in [".", "..", "\\"] {
        input.temporary_variables = vec![pair("id", value)];
        assert!(
            preview(&workspace, &input).is_err(),
            "accepted value {value}"
        );
    }
}

#[test]
fn rejects_unsafe_base_urls_without_leaking_them() {
    let (mut workspace, input) = fixture();
    for base in [
        "file:///secret",
        "ftp://host/secret",
        "http://user:secret@host/gw",
        "http://host/gw?secret=1",
        "http://host/gw#secret",
        "http://host/../secret",
        "http://host/%2e%2e/secret",
        "http://host\\secret",
        "http://host/bad%",
        "http://host/\nsecret",
        "http://@host/secret",
    ] {
        workspace.bindings[0].base_url = base.into();
        let error = preview(&workspace, &input).expect_err(base);
        assert!(!error.contains("secret"));
    }
}

#[test]
fn query_is_a_duplicate_ordered_list_and_encodes_once() {
    let (workspace, mut input) = fixture();
    input.request.query = vec![pair("tag", "a/b"), pair("tag", "a%2Fb"), pair("x", "off")];
    input.request.query[2].enabled = false;
    let result = preview(&workspace, &input).unwrap();
    let url = url::Url::parse(&result.url).unwrap();
    assert_eq!(
        url.query_pairs().collect::<Vec<_>>(),
        vec![("tag".into(), "a/b".into()), ("tag".into(), "a%2Fb".into()),]
    );
}

#[test]
fn rejects_header_injection_missing_body_variables_and_json_key_templates() {
    let (workspace, mut input) = fixture();
    input.request.headers = vec![pair("x-test", "value\r\nx-injected: yes")];
    assert!(preview(&workspace, &input).is_err());
    input.request.headers = vec![pair("bad\nname", "value")];
    assert!(preview(&workspace, &input).is_err());
    input.request.headers.clear();
    input.request.body_type = "json".into();
    for body in [
        r#"{"key": {{value}}}"#,
        r#"{"{{key}}": "value"}"#,
        r#"{"nested":[{"{{key}}":1}]}"#,
        r#"{"key":"{{missing}}"}"#,
    ] {
        input.request.body = body.into();
        assert!(preview(&workspace, &input).is_err(), "accepted {body}");
    }
}

#[test]
fn masking_a_sensitive_query_key_does_not_hide_missing_variables() {
    let (workspace, mut input) = fixture();
    input.request.query = vec![pair("access_token", "{{missing}}")];
    assert!(preview(&workspace, &input).is_err());
}

#[test]
fn literal_closing_braces_are_not_mistaken_for_placeholders() {
    let (workspace, mut input) = fixture();
    input.request.body_type = "text".into();
    input.request.body = r#"{"nested":{"number":1}}"#.into();
    assert!(preview(&workspace, &input).is_ok());
    input.request.body_type = "json".into();
    input.request.body = r#"{"literal}}": "text}}"}"#.into();
    assert!(preview(&workspace, &input).is_ok());
}

#[tokio::test]
async fn execution_revalidates_real_secrets_instead_of_trusting_masked_preview() {
    let (mut workspace, mut input) = fixture();
    set_variables(
        &mut workspace,
        vec![variable("project", "p", "v", "..", true)],
    );
    input.request.path = "/{{v}}/admin".into();
    assert!(preview(&workspace, &input).is_ok());
    let error = execute(&workspace, input.clone(), CancellationToken::new())
        .await
        .unwrap_err();
    assert!(error.contains("路径"));
    input.request.path = "/users".into();
    input.request.headers = vec![pair("x-test", "{{v}}")];
    workspace.variables[0].value = "invalid\r\ninjected: secret".into();
    assert!(preview(&workspace, &input).is_ok());
    let error = execute(&workspace, input, CancellationToken::new())
        .await
        .unwrap_err();
    assert!(error.contains("Header"));
    assert!(!error.contains("secret"));
}

/// Read one complete Content-Length request and report the wire representation.
async fn read_request(stream: &mut tokio::net::TcpStream) -> Vec<u8> {
    let mut data = Vec::new();
    let mut buf = [0; 4096];
    loop {
        let count = stream.read(&mut buf).await.unwrap();
        assert_ne!(count, 0, "client closed before request completed");
        data.extend_from_slice(&buf[..count]);
        if let Some(end) = data.windows(4).position(|p| p == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&data[..end]);
            let length = headers
                .lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    key.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            if data.len() >= end + 4 + length {
                return data;
            }
        }
    }
}

async fn server(
    status: &str,
    headers: &str,
    body: Vec<u8>,
    delay: Duration,
) -> (
    String,
    oneshot::Receiver<Vec<u8>>,
    tokio::task::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}/gateway", listener.local_addr().unwrap());
    let status = status.to_owned();
    let headers = headers.to_owned();
    let (tx, rx) = oneshot::channel();
    let handle = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let data = read_request(&mut stream).await;
        let _ = tx.send(data);
        tokio::time::sleep(delay).await;
        let head = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\n{headers}Connection: close\r\n\r\n",
            body.len()
        );
        if stream.write_all(head.as_bytes()).await.is_ok() {
            let _ = stream.write_all(&body).await;
        }
    });
    (address, rx, handle)
}

#[tokio::test]
async fn sends_encoded_path_repeated_headers_query_and_serialized_json() {
    let (base, request_rx, handle) = server(
        "200 OK",
        "X-Reply: one\r\nX-Reply: two\r\n",
        b"ok".to_vec(),
        Duration::ZERO,
    )
    .await;
    let (mut workspace, mut input) = fixture();
    workspace.bindings[0].base_url = base;
    input.request.method = "POST".into();
    input.request.path = "/files//a%20b/{{id}}".into();
    input.request.query = vec![pair("q", "{{id}}"), pair("q", "second")];
    input.request.headers = vec![pair("x-repeat", "one"), pair("x-repeat", "two")];
    input.request.body_type = "json".into();
    input.request.body = r#"{"value":"{{value}}","nested":["{{value}}",true,2]}"#.into();
    input.temporary_variables = vec![pair("id", "a/b"), pair("value", "\"\n{{missing}}")];
    let response = execute(&workspace, input, CancellationToken::new())
        .await
        .unwrap();
    let wire = request_rx.await.unwrap();
    let text = String::from_utf8(wire).unwrap();
    assert!(
        text.starts_with("POST /gateway/files//a%20b/a%2Fb?q=a%2Fb&q=second HTTP/1.1\r\n"),
        "{text}"
    );
    assert!(text.contains("x-repeat: one\r\n"));
    assert!(text.contains("x-repeat: two\r\n"));
    assert!(text.contains("content-type: application/json\r\n"));
    let body: Value = serde_json::from_str(text.split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(body["value"], "\"\n{{missing}}");
    assert_eq!(body["nested"][0], "\"\n{{missing}}");
    assert_eq!(body["nested"][1], true);
    assert_eq!(body["nested"][2], 2);
    assert_eq!(response.status, 200);
    assert_eq!(response.body, "ok");
    assert!(!response.truncated);
    assert_eq!(
        response
            .headers
            .iter()
            .filter(|p| p.key == "x-reply")
            .count(),
        2
    );
    handle.await.unwrap();
}

#[tokio::test]
async fn http_4xx_is_a_response_not_a_transport_failure() {
    let (base, _, handle) = server(
        "422 Unprocessable Entity",
        "",
        b"bad input".to_vec(),
        Duration::ZERO,
    )
    .await;
    let (mut workspace, input) = fixture();
    workspace.bindings[0].base_url = base;
    let result = execute(&workspace, input, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(result.status, 422);
    assert_eq!(result.body, "bad input");
    assert_eq!(result.size_bytes, 9);
    handle.await.unwrap();
}

#[tokio::test]
async fn production_requires_confirmation_before_any_connection() {
    let (mut workspace, input) = fixture();
    workspace.environments[0].is_production = true;
    assert!(preview(&workspace, &input).unwrap().is_production);
    let error = execute(&workspace, input, CancellationToken::new())
        .await
        .unwrap_err();
    assert!(error.contains("生产"), "{error}");
}

#[tokio::test]
async fn redirect_is_returned_without_following_or_replaying() {
    let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let location = format!(
        "Location: http://{}/other\r\n",
        target.local_addr().unwrap()
    );
    let (base, _, handle) =
        server("307 Temporary Redirect", &location, vec![], Duration::ZERO).await;
    let (mut workspace, mut input) = fixture();
    workspace.bindings[0].base_url = base;
    input.request.method = "POST".into();
    let response = execute(&workspace, input, CancellationToken::new())
        .await
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
async fn timeout_covers_waiting_for_headers() {
    let (base, _, handle) = server("200 OK", "", vec![], Duration::from_secs(5)).await;
    let (mut workspace, mut input) = fixture();
    workspace.bindings[0].base_url = base;
    input.request.timeout_ms = 80;
    let error = execute(&workspace, input, CancellationToken::new())
        .await
        .unwrap_err();
    assert!(error.contains("超时"), "{error}");
    handle.abort();
}

#[tokio::test]
async fn cancellation_interrupts_inflight_and_pre_cancelled_requests() {
    let (base, request_rx, handle) = server("200 OK", "", vec![], Duration::from_secs(5)).await;
    let (mut workspace, input) = fixture();
    workspace.bindings[0].base_url = base;
    let cancel = CancellationToken::new();
    let token = cancel.clone();
    let task = tokio::spawn(async move { execute(&workspace, input, token).await });
    request_rx.await.unwrap();
    cancel.cancel();
    let error = tokio::time::timeout(Duration::from_secs(1), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap_err();
    assert!(error.contains("取消"), "{error}");
    handle.abort();
    let (workspace, input) = fixture();
    let error = execute(&workspace, input, cancel).await.unwrap_err();
    assert!(error.contains("取消"), "{error}");
}

#[tokio::test]
async fn response_preview_is_bounded_and_size_counts_only_received_chunks() {
    const LIMIT: usize = 2 * 1024 * 1024;
    for size in [LIMIT - 1, LIMIT, LIMIT + 37, 4 * LIMIT] {
        let (base, _, handle) = server("200 OK", "", vec![b'x'; size], Duration::ZERO).await;
        let (mut workspace, input) = fixture();
        workspace.bindings[0].base_url = base;
        let result = execute(&workspace, input, CancellationToken::new())
            .await
            .unwrap();
        if size <= LIMIT {
            assert_eq!(result.size_bytes as usize, size);
        } else {
            // The final received chunk is counted in full, but unread bytes
            // advertised by Content-Length must NOT be presented as received.
            assert!(result.size_bytes as usize > LIMIT);
            assert!(result.size_bytes as usize <= size);
            if size == 4 * LIMIT {
                assert!((result.size_bytes as usize) < size);
            }
        }
        assert_eq!(result.body.len(), size.min(LIMIT));
        assert_eq!(result.truncated, size > LIMIT);
        handle.await.unwrap();
    }
}

#[tokio::test]
async fn response_limit_returns_promptly_for_a_continuous_chunked_stream() {
    const LIMIT: usize = 2 * 1024 * 1024;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        read_request(&mut stream).await;
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
            .await
            .unwrap();
        // The first HTTP chunk fills the cap exactly. The very next chunk
        // exceeds it by one byte; after that the server never sends EOF.
        stream
            .write_all(format!("{LIMIT:X}\r\n").as_bytes())
            .await
            .unwrap();
        stream.write_all(&vec![b'x'; LIMIT]).await.unwrap();
        stream.write_all(b"\r\n").await.unwrap();
        loop {
            if stream.write_all(b"1\r\ny\r\n").await.is_err() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    });
    let (mut workspace, mut input) = fixture();
    workspace.bindings[0].base_url = format!("http://{address}");
    input.request.timeout_ms = 2000;
    let started = tokio::time::Instant::now();
    let result = execute(&workspace, input, CancellationToken::new()).await;
    let elapsed = started.elapsed();
    // Clean up even on the expected RED failure, where the old implementation
    // keeps draining until its overall request timeout fires.
    server.abort();
    let result = result.expect("超出接收上限应立即返回截断响应，而不是等待整体超时");
    assert!(elapsed < Duration::from_secs(1), "elapsed: {elapsed:?}");
    assert!(result.truncated);
    assert_eq!(result.body.len(), LIMIT);
    assert_eq!(result.size_bytes, LIMIT as u64 + 1);
}

#[tokio::test]
async fn response_at_exact_limit_waits_for_chunked_eof_without_truncating() {
    const LIMIT: usize = 2 * 1024 * 1024;
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (prefix_tx, prefix_rx) = oneshot::channel();
    let (eof_tx, eof_rx) = oneshot::channel();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        read_request(&mut stream).await;
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n")
            .await
            .unwrap();
        stream
            .write_all(format!("{LIMIT:X}\r\n").as_bytes())
            .await
            .unwrap();
        stream.write_all(&vec![b'x'; LIMIT]).await.unwrap();
        stream.write_all(b"\r\n").await.unwrap();
        let _ = prefix_tx.send(());
        eof_rx.await.unwrap();
        stream.write_all(b"0\r\n\r\n").await.unwrap();
    });
    let (mut workspace, input) = fixture();
    workspace.bindings[0].base_url = format!("http://{address}");
    let mut request =
        tokio::spawn(async move { execute(&workspace, input, CancellationToken::new()).await });
    prefix_rx.await.unwrap();
    let early_result = tokio::time::timeout(Duration::from_millis(100), &mut request).await;
    let _ = eof_tx.send(());
    if early_result.is_ok() {
        server.abort();
        panic!("恰好达到上限时，必须再读取 EOF 或下一个 chunk 才能判定是否截断");
    }
    let result = request.await.unwrap().unwrap();
    assert!(!result.truncated);
    assert_eq!(result.body.len(), LIMIT);
    assert_eq!(result.size_bytes, LIMIT as u64);
    server.await.unwrap();
}

#[tokio::test]
async fn timeout_range_is_bounded_in_both_preview_and_execution() {
    let (workspace, mut input) = fixture();
    for timeout in [1, 300_000] {
        input.request.timeout_ms = timeout;
        assert!(preview(&workspace, &input).is_ok(), "timeout: {timeout}");
    }
    for timeout in [300_001, u64::MAX, 0] {
        input.request.timeout_ms = timeout;
        let error = preview(&workspace, &input).expect_err("must reject invalid timeout");
        assert!(error.contains("300000"), "{error}");
        let error = execute(&workspace, input.clone(), CancellationToken::new())
            .await
            .unwrap_err();
        assert!(error.contains("300000"), "{error}");
    }
}

#[tokio::test]
async fn response_url_is_masked_but_actual_request_contains_secret() {
    let (base, request_rx, handle) = server("200 OK", "", vec![], Duration::ZERO).await;
    let (mut workspace, mut input) = fixture();
    workspace.bindings[0].base_url = base;
    set_variables(
        &mut workspace,
        vec![variable("environment", "e", "token", "private-token", true)],
    );
    input.request.query = vec![pair("token", "{{token}}")];
    let result = execute(&workspace, input, CancellationToken::new())
        .await
        .unwrap();
    assert!(!result.url.contains("private-token"));
    assert!(String::from_utf8(request_rx.await.unwrap())
        .unwrap()
        .contains("private-token"));
    handle.await.unwrap();
}

#[tokio::test]
async fn transport_errors_do_not_contain_secret_url() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let (mut workspace, mut input) = fixture();
    workspace.bindings[0].base_url = format!("http://{address}");
    input.request.path = "/private-token".into();
    let error = execute(&workspace, input, CancellationToken::new())
        .await
        .unwrap_err();
    assert!(!error.contains("private-token"));
    assert!(!error.contains(&address.to_string()));
}

#[test]
fn inactive_templates_are_not_resolved_and_invalid_options_are_rejected() {
    let (workspace, mut input) = fixture();
    input.request.query = vec![pair("q", "{{missing}}")];
    input.request.query[0].enabled = false;
    input.request.headers = input.request.query.clone();
    input.request.body = "{{missing}}".into();
    assert!(preview(&workspace, &input).is_ok());
    input.request.timeout_ms = 0;
    assert!(preview(&workspace, &input).is_err());
    input.request.timeout_ms = 100;
    input.request.method = "GET\r\nX-Test: yes".into();
    assert!(preview(&workspace, &input).is_err());
}

#[test]
fn secrets_stay_secret_when_overridden_by_an_ordinary_scope() {
    let (mut workspace, mut input) = fixture();
    set_variables(
        &mut workspace,
        vec![
            variable("project", "p", "v", "first-secret", true),
            variable("request", "r", "v", "override-secret", false),
        ],
    );
    input.request.query = vec![pair("q", "{{v}}")];
    assert!(
        !serde_json::to_string(&preview(&workspace, &input).unwrap())
            .unwrap()
            .contains("override-secret")
    );
}

#[test]
fn duplicate_variables_in_one_scope_are_rejected_instead_of_order_dependent() {
    let (mut workspace, input) = fixture();
    set_variables(
        &mut workspace,
        vec![
            variable("project", "p", "v", "a", false),
            variable("project", "p", "v", "b", false),
        ],
    );
    assert!(preview(&workspace, &input).is_err());
}

#[test]
fn dot_segments_formed_across_tokens_are_rejected() {
    let (workspace, mut input) = fixture();
    input.request.path = "/.{{dot}}/admin".into();
    input.temporary_variables = vec![pair("dot", ".")];
    assert!(preview(&workspace, &input).is_err());
}

#[tokio::test]
async fn timeout_and_cancellation_also_cover_stalled_body_reads() {
    for should_cancel in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (started_tx, started_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            read_request(&mut stream).await;
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\nx")
                .await
                .unwrap();
            let _ = started_tx.send(());
            tokio::time::sleep(Duration::from_secs(5)).await;
        });
        let (mut workspace, mut input) = fixture();
        workspace.bindings[0].base_url = format!("http://{address}");
        input.request.timeout_ms = if should_cancel { 2000 } else { 100 };
        let cancel = CancellationToken::new();
        let token = cancel.clone();
        let task = tokio::spawn(async move { execute(&workspace, input, token).await });
        started_rx.await.unwrap();
        if should_cancel {
            cancel.cancel();
        }
        let error = tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(
            error.contains(if should_cancel { "取消" } else { "超时" }),
            "{error}"
        );
        server.abort();
    }
}

#[tokio::test]
async fn disconnected_write_request_is_not_automatically_retried() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let data = read_request(&mut stream).await;
        drop(stream);
        assert!(
            tokio::time::timeout(Duration::from_millis(200), listener.accept())
                .await
                .is_err()
        );
        data
    });
    let (mut workspace, mut input) = fixture();
    workspace.bindings[0].base_url = format!("http://{address}");
    input.request.method = "POST".into();
    input.request.body_type = "text".into();
    input.request.body = "write-once".into();
    assert!(execute(&workspace, input, CancellationToken::new())
        .await
        .is_err());
    assert!(String::from_utf8(server.await.unwrap())
        .unwrap()
        .ends_with("write-once"));
}

#[tokio::test]
async fn chunked_body_size_is_counted_without_content_length() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        read_request(&mut stream).await;
        stream.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n4\r\ndefg\r\n0\r\n\r\n").await.unwrap();
    });
    let (mut workspace, input) = fixture();
    workspace.bindings[0].base_url = format!("http://{address}");
    let response = execute(&workspace, input, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(response.body, "abcdefg");
    assert_eq!(response.size_bytes, 7);
    server.await.unwrap();
}

#[tokio::test]
async fn invalid_utf8_preview_still_obeys_two_mib_display_limit() {
    let (base, _, handle) = server("200 OK", "", vec![0xff; 1024 * 1024], Duration::ZERO).await;
    let (mut workspace, input) = fixture();
    workspace.bindings[0].base_url = base;
    let result = execute(&workspace, input, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(result.size_bytes, 1024 * 1024);
    assert!(result.body.len() <= 2 * 1024 * 1024);
    assert!(
        result.truncated,
        "lossy UTF-8 expansion must not silently exceed the preview cap"
    );
    handle.await.unwrap();
}
