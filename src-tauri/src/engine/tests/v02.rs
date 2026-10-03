use super::*;
use crate::engine::prepare::{prepare, Mode};
use crate::models::{AuthConfig, FormField};

fn auth(value: Value) -> Option<AuthConfig> {
    Some(serde_json::from_value(value).unwrap())
}

fn field(key: &str, value: &str, kind: &str) -> FormField {
    FormField {
        id: key.into(),
        key: key.into(),
        value: value.into(),
        enabled: true,
        kind: kind.into(),
    }
}

#[test]
fn service_headers_request_group_override_is_case_insensitive() {
    let (mut w, mut i) = fixture();
    w.services[0].headers = vec![
        pair("X-Group", "{{missing}}"),
        pair("x-group", "old"),
        pair("X-Keep", "keep"),
    ];
    i.request.headers = vec![pair("x-GROUP", "one"), pair("X-group", "two")];
    let p = prepare(&w, &i, Mode::Execute).unwrap();
    assert_eq!(
        p.headers
            .get_all("x-group")
            .iter()
            .map(|v| v.to_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["one", "two"]
    );
    assert_eq!(p.headers["x-keep"], "keep");
    i.request.headers.iter_mut().for_each(|p| p.enabled = false);
    assert!(prepare(&w, &i, Mode::Execute).is_err());
}

#[test]
fn p2_header_group_override_compares_expanded_names_before_service_values() {
    for (service_key, request_key) in [
        ("X-Group", "{{h}}"),
        ("{{h}}", "X-Group"),
        ("{{service_header}}", "{{h}}"),
    ] {
        let (mut w, mut i) = fixture();
        i.temporary_variables = vec![
            pair("h", "x-group"),
            pair("service_header", "X-GROUP"),
            pair("duplicate_header", "x-GrOup"),
        ];
        w.services[0].headers = vec![
            pair(service_key, "{{missing_secret}}"),
            pair("X-Group", "old"),
            pair("X-Keep", "keep"),
        ];
        i.request.headers = vec![
            pair(request_key, "new"),
            pair("{{duplicate_header}}", "second"),
        ];
        for mode in [Mode::Execute, Mode::Preview] {
            let p = prepare(&w, &i, mode).expect("overridden service values must not resolve");
            assert_eq!(
                p.headers
                    .get_all("x-group")
                    .iter()
                    .map(|v| v.to_str().unwrap())
                    .collect::<Vec<_>>(),
                ["new", "second"]
            );
            assert_eq!(p.headers["x-keep"], "keep");
        }
        let curl = export_curl(&w, &i).unwrap();
        assert!(!curl.contains("old"));
        assert_eq!(curl.matches("x-group:").count(), 2);
        i.request.headers.iter_mut().for_each(|p| p.enabled = false);
        assert!(
            preview(&w, &i).is_err(),
            "disabled overrides must not hide missing defaults"
        );
    }
}

#[tokio::test]
async fn p2_expanded_header_override_is_the_only_group_sent_on_wire() {
    let (base, rx, handle) = server("200 OK", "", vec![], Duration::ZERO).await;
    let (mut w, mut i) = fixture();
    w.bindings[0].base_url = base;
    w.services[0].headers = vec![pair("X-Group", "old")];
    i.temporary_variables = vec![pair("h", "x-group")];
    i.request.headers = vec![pair("{{h}}", "new")];
    execute(&w, i, CancellationToken::new()).await.unwrap();
    let wire = String::from_utf8(rx.await.unwrap()).unwrap();
    assert_eq!(wire.matches("x-group:").count(), 1);
    assert!(wire.contains("x-group: new\r\n"));
    assert!(!wire.contains("old"));
    handle.await.unwrap();
}

#[test]
fn p2_curl_head_uses_head_semantics_and_other_methods_remain_explicit() {
    let (w, mut i) = fixture();
    i.request.method = "HEAD".into();
    let curl = export_curl(&w, &i).unwrap();
    assert!(curl.contains("--head"), "{curl}");
    assert!(!curl.contains("--request 'HEAD'"), "{curl}");
    for method in ["GET", "POST", "DELETE"] {
        i.request.method = method.into();
        let curl = export_curl(&w, &i).unwrap();
        assert!(curl.contains(&format!("--request '{method}'")));
        assert!(!curl.contains("--head"));
    }
}

#[test]
fn curl_head_rejects_any_prepared_body_without_restricting_native_preparation() {
    let (w, mut i) = fixture();
    i.request.method = "HEAD".into();
    for (body_type, body, form) in [
        ("text", "", vec![]),
        ("text", "private-body", vec![]),
        ("json", "{}", vec![]),
        ("form", "", vec![]),
        ("form", "", vec![field("a", "private-body", "text")]),
        ("multipart", "", vec![]),
        (
            "multipart",
            "",
            vec![field("f", "private-file-path", "file")],
        ),
    ] {
        i.request.body_type = body_type.into();
        i.request.body = body.into();
        i.request.form = form;
        let prepared = prepare(&w, &i, Mode::Execute).unwrap();
        assert!(prepared.body.is_some() || prepared.multipart.is_some());
        let error = export_curl(&w, &i).expect_err("HEAD with any prepared body must not export");
        assert!(error.contains("HEAD"), "{error}");
        assert!(!error.contains("private"));
    }
    i.request.body_type = "none".into();
    assert!(export_curl(&w, &i).unwrap().contains("--head"));
}

#[test]
fn p2_secret_header_names_compare_real_values_not_shared_preview_mask() {
    let (mut w, mut i) = fixture();
    set_variables(
        &mut w,
        vec![
            variable("project", "p", "service_header", "X-Group", true),
            variable("project", "p", "request_header", "x-group", true),
        ],
    );
    w.services[0].headers = vec![pair("{{service_header}}", "{{missing_secret}}")];
    i.request.headers = vec![pair("{{request_header}}", "new")];
    for mode in [Mode::Execute, Mode::Preview] {
        let p = prepare(&w, &i, mode).expect("known expanded names identify the override");
        assert_eq!(p.headers.len(), 1);
        assert_eq!(p.headers.values().next().unwrap(), "new");
    }
    // Store::load strips secret values. Two unknown names MUST NOT compare
    // equal merely because their display projections both become "redacted".
    w.variables.iter_mut().for_each(|v| v.value.clear());
    assert!(preview(&w, &i).is_err());
}

#[test]
fn p2_case_sensitive_variable_names_do_not_override_distinct_headers() {
    let (mut w, mut i) = fixture();
    i.temporary_variables = vec![pair("h", "x-keep"), pair("H", "x-group")];
    w.services[0].headers = vec![pair("{{h}}", "keep")];
    i.request.headers = vec![pair("{{H}}", "new")];
    let p = prepare(&w, &i, Mode::Execute).unwrap();
    assert_eq!(
        p.headers.get("x-keep").map(|v| v.to_str().unwrap()),
        Some("keep")
    );
    assert_eq!(p.headers["x-group"], "new");
}

#[cfg(windows)]
#[tokio::test]
async fn p2_curl_head_accepts_content_length_without_a_response_body() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (mut w, mut i) = fixture();
    w.bindings[0].base_url = format!("http://{}", listener.local_addr().unwrap());
    i.request.method = "HEAD".into();
    let exported = export_curl(&w, &i).unwrap();
    let url = preview(&w, &i).unwrap().url;
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let wire = read_request(&mut stream).await;
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1234\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        wire
    });
    // Test only the exported method option, never execute the exported shell
    // command. argv is fixed here and the sole destination is this loopback.
    let output = tokio::task::spawn_blocking(move || {
        use std::os::windows::process::CommandExt;
        let mut command = std::process::Command::new("curl.exe");
        command.args([
            "--disable",
            "--noproxy",
            "*",
            "--silent",
            "--show-error",
            "--max-time",
            "2",
        ]);
        if exported
            .lines()
            .any(|line| line.trim().trim_end_matches('\\').trim() == "--head")
        {
            command.arg("--head");
        } else {
            assert!(exported.contains("--request 'HEAD'"));
            command.args(["--request", "HEAD"]);
        }
        command
            .args(["--url", &url])
            .creation_flags(0x08000000)
            .output()
            .unwrap()
    })
    .await
    .unwrap();
    let wire = server.await.unwrap();
    assert!(wire.starts_with(b"HEAD /users HTTP/1.1\r\n"));
    assert!(
        output.status.success(),
        "curl exit {:?}: {}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn auth_inherits_explicit_none_disables_and_credentials_require_exact_refs() {
    let (mut w, mut i) = fixture();
    w.services[0].auth = auth(json!({"kind":"bearer","token":"{{secret}}"}));
    set_variables(
        &mut w,
        vec![variable(
            "project",
            "p",
            "secret",
            "private-credential",
            true,
        )],
    );
    assert_eq!(
        prepare(&w, &i, Mode::Execute).unwrap().headers["authorization"],
        "Bearer private-credential"
    );
    i.request.auth = auth(json!({"kind":"none"}));
    assert!(!prepare(&w, &i, Mode::Execute)
        .unwrap()
        .headers
        .contains_key("authorization"));
    for bad in [
        "plaintext-secret",
        "prefix{{secret}}",
        "{{secret}}suffix",
        "{{secret}}{{secret}}",
        "{{}}",
        " {{secret}}",
        "{{secret}}\r\n",
    ] {
        i.request.auth = auth(json!({"kind":"bearer","token":bad}));
        let error = preview(&w, &i).unwrap_err();
        assert!(!error.contains(bad));
    }
}

#[test]
fn auth_header_and_query_conflicts_reject_and_preview_hides_credentials() {
    let (mut w, mut i) = fixture();
    set_variables(
        &mut w,
        vec![variable(
            "project",
            "p",
            "secret",
            "private-credential",
            false,
        )],
    );
    i.request.auth =
        auth(json!({"kind":"apiKey","key":"custom","value":"{{secret}}","location":"query"}));
    let p = prepare(&w, &i, Mode::Execute).unwrap();
    assert!(p.url.as_str().contains("private-credential"));
    assert!(!serde_json::to_string(&preview(&w, &i).unwrap())
        .unwrap()
        .contains("private-credential"));
    i.request.query = vec![pair("custom", "manual")];
    assert!(preview(&w, &i).is_err());
    i.request.query.clear();
    i.request.auth = auth(json!({"kind":"bearer","token":"{{secret}}"}));
    w.services[0].headers = vec![pair("AUTHORIZATION", "manual")];
    assert!(preview(&w, &i).is_err());
}

#[tokio::test]
async fn all_auth_kinds_are_sent_as_real_loopback_bytes() {
    for (config, expected) in [
        (
            json!({"kind":"bearer","token":"{{secret}}"}),
            "authorization: Bearer credential\r\n",
        ),
        (
            json!({"kind":"basic","username":"user","password":"{{secret}}"}),
            "authorization: Basic dXNlcjpjcmVkZW50aWFs\r\n",
        ),
        (
            json!({"kind":"apiKey","key":"X-Custom","value":"{{secret}}","location":"header"}),
            "x-custom: credential\r\n",
        ),
        (
            json!({"kind":"apiKey","key":"custom","value":"{{secret}}","location":"query"}),
            "?custom=credential HTTP/1.1\r\n",
        ),
    ] {
        let (base, rx, handle) = server("200 OK", "", vec![], Duration::ZERO).await;
        let (mut w, mut i) = fixture();
        w.bindings[0].base_url = base;
        set_variables(
            &mut w,
            vec![variable("project", "p", "secret", "credential", true)],
        );
        i.request.auth = auth(config);
        execute(&w, i, CancellationToken::new()).await.unwrap();
        assert!(String::from_utf8(rx.await.unwrap())
            .unwrap()
            .contains(expected));
        handle.await.unwrap();
    }
}

#[tokio::test]
async fn form_encodes_duplicates_and_text_values_on_wire() {
    let (base, rx, handle) = server("200 OK", "", vec![], Duration::ZERO).await;
    let (mut w, mut i) = fixture();
    w.bindings[0].base_url = base;
    i.request.method = "POST".into();
    i.request.body_type = "form".into();
    i.request.form = vec![field("a", "a &+中", "text"), field("a", "{{v}}", "text")];
    i.temporary_variables = vec![pair("v", "two")];
    execute(&w, i, CancellationToken::new()).await.unwrap();
    let wire = String::from_utf8(rx.await.unwrap()).unwrap();
    assert!(wire.contains("content-type: application/x-www-form-urlencoded\r\n"));
    assert!(wire.ends_with("a=a+%26%2B%E4%B8%AD&a=two"), "{wire}");
    handle.await.unwrap();
}

#[test]
fn form_rejects_files_and_multipart_rejects_injected_names() {
    let (w, mut i) = fixture();
    i.request.body_type = "form".into();
    i.request.form = vec![field("f", "C:\\secret-path", "file")];
    assert!(preview(&w, &i).is_err());
    i.request.body_type = "multipart".into();
    i.request.form = vec![field("bad\r\nheader", "text", "text")];
    assert!(preview(&w, &i).is_err());
    i.request.form = vec![field("f", "missing-secret-path", "file")];
    assert!(
        preview(&w, &i).is_ok(),
        "preview must never inspect file paths"
    );
}

#[tokio::test]
async fn multipart_has_duplicate_text_and_file_bytes_without_path_in_filename() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("report.csv");
    std::fs::write(&file, b"file bytes").unwrap();
    let image = dir.path().join("picture.png");
    std::fs::write(&image, b"image bytes").unwrap();
    let (base, rx, handle) = server("200 OK", "", vec![], Duration::ZERO).await;
    let (mut w, mut i) = fixture();
    w.bindings[0].base_url = base;
    i.request.method = "POST".into();
    i.request.body_type = "multipart".into();
    i.request.form = vec![
        field("a", "one", "text"),
        field("a", "two", "text"),
        field("f", file.to_str().unwrap(), "file"),
        field("f", image.to_str().unwrap(), "file"),
    ];
    execute(&w, i, CancellationToken::new()).await.unwrap();
    let wire = String::from_utf8(rx.await.unwrap()).unwrap();
    assert!(wire.contains("content-type: multipart/form-data; boundary="));
    assert_eq!(wire.matches("name=\"a\"").count(), 2);
    assert!(wire.contains("file bytes"));
    assert!(wire.contains("filename=\"report.csv\""));
    assert!(wire.contains("filename=\"picture.png\""));
    assert_eq!(wire.matches("name=\"f\"; filename=").count(), 2);
    assert!(!wire.contains(dir.path().file_name().unwrap().to_str().unwrap()));
    assert!(!wire.contains(dir.path().to_str().unwrap()));
    handle.await.unwrap();
}

#[tokio::test]
async fn upload_filename_controls_reject_without_echoing_path() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("private\r\nname.csv");
    let (w, mut i) = fixture();
    i.request.body_type = "multipart".into();
    i.request.form = vec![field("f", file.to_str().unwrap(), "file")];
    assert!(preview(&w, &i).is_ok());
    assert!(!export_curl(&w, &i).unwrap().contains("private"));
    let error = execute(&w, i, CancellationToken::new()).await.unwrap_err();
    assert!(error.contains("名称禁止控制字符"), "{error}");
    assert!(!error.contains("private"));
    assert!(!error.contains(dir.path().to_str().unwrap()));
}

#[tokio::test]
async fn upload_limits_and_invalid_paths_fail_before_connection_without_path_leaks() {
    let dir = tempfile::tempdir().unwrap();
    let large = dir.path().join("private-large");
    let f = std::fs::File::create(&large).unwrap();
    f.set_len(10 * 1024 * 1024 + 1).unwrap();
    drop(f);
    for paths in [
        vec![large.to_str().unwrap().to_owned()],
        vec![dir.path().to_str().unwrap().to_owned()],
        vec![dir
            .path()
            .join("private-missing")
            .to_str()
            .unwrap()
            .to_owned()],
        vec!["relative-private-path".to_owned()],
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (mut w, mut i) = fixture();
        w.bindings[0].base_url = format!("http://{}", listener.local_addr().unwrap());
        i.request.body_type = "multipart".into();
        i.request.form = paths.iter().map(|p| field("file", p, "file")).collect();
        let error = execute(&w, i, CancellationToken::new()).await.unwrap_err();
        assert!(!error.contains("private"), "{error}");
        assert!(
            tokio::time::timeout(Duration::from_millis(30), listener.accept())
                .await
                .is_err()
        );
    }
    std::fs::OpenOptions::new()
        .write(true)
        .open(&large)
        .unwrap()
        .set_len(10 * 1024 * 1024)
        .unwrap();
    let (w, mut i) = fixture();
    i.request.body_type = "multipart".into();
    i.request.form = vec![field("f", large.to_str().unwrap(), "file"); 3];
    let error = execute(&w, i, CancellationToken::new()).await.unwrap_err();
    assert!(error.contains("20"), "{error}");
}

#[test]
fn curl_is_redacted_posix_quoted_and_does_not_interpret_body_as_file() {
    let (mut w, mut i) = fixture();
    set_variables(
        &mut w,
        vec![variable("project", "p", "secret", "private-secret", true)],
    );
    i.request.method = "POST".into();
    i.request.query = vec![pair("q", "{{secret}}")];
    i.request.headers = vec![
        pair("Authorization", "Bearer manual-private"),
        pair("X-Repeat", "one"),
        pair("X-Repeat", "two"),
    ];
    i.request.body_type = "text".into();
    i.request.body = "@private-file $(not-executed) 'quoted' {{secret}}".into();
    let curl = export_curl(&w, &i).unwrap();
    assert!(!curl.contains("private-secret"));
    assert!(!curl.contains("manual-private"));
    assert!(curl.contains("--data-raw"));
    assert!(!curl.contains("--data-binary"));
    assert!(curl.contains("'\"'\"'quoted'\"'\"'"), "{curl}");
    assert_eq!(curl.matches("x-repeat:").count(), 2);
    assert!(curl.contains("--max-time"));
    assert!(!curl.contains("--retry"));
    assert!(!curl.contains("--location"));
}

#[test]
fn curl_multipart_uses_placeholders_without_accessing_paths_or_running_commands() {
    let (mut w, mut i) = fixture();
    set_variables(
        &mut w,
        vec![variable("project", "p", "secret", "private-secret", false)],
    );
    i.request.auth =
        auth(json!({"kind":"apiKey","key":"custom","value":"{{secret}}","location":"header"}));
    i.request.body_type = "multipart".into();
    i.request.form = vec![
        field("f", "C:\\private-missing\\secret-name.txt", "file"),
        field("a", "@do-not-read", "text"),
    ];
    let curl = export_curl(&w, &i).unwrap();
    assert!(!curl.contains("private-missing"));
    assert!(!curl.contains("secret-name"));
    assert!(!curl.contains("private-secret"));
    assert!(curl.contains("/REPLACE/WITH/UPLOAD_FILE_1"));
    assert!(curl.contains("--form-string 'a=@do-not-read'"), "{curl}");
}

#[test]
fn auth_rejects_control_characters_in_basic_and_api_key_without_echoing_values() {
    for config in [
        json!({"kind":"basic","username":"bad\r\nprivate-user","password":"{{secret}}"}),
        json!({"kind":"basic","username":"a:b","password":"{{secret}}"}),
        json!({"kind":"apiKey","key":"bad\r\nprivate-name","value":"{{secret}}","location":"query"}),
        json!({"kind":"apiKey","key":"Host","value":"{{secret}}","location":"header"}),
        json!({"kind":"apiKey","key":"x-key","value":"{{secret}}","location":"invalid"}),
        json!({"kind":"unknown"}),
    ] {
        let (mut w, mut i) = fixture();
        set_variables(
            &mut w,
            vec![variable(
                "project",
                "p",
                "secret",
                "private\r\ncredential",
                true,
            )],
        );
        i.request.auth = auth(config);
        let error = prepare(&w, &i, Mode::Execute)
            .err()
            .expect("invalid auth must reject");
        assert!(!error.contains("private"));
    }
}

#[tokio::test]
async fn multipart_rejects_content_type_override_and_does_not_retry_disconnects() {
    let (w, mut i) = fixture();
    i.request.body_type = "multipart".into();
    i.request.headers = vec![pair("Content-Type", "multipart/form-data; boundary=forged")];
    assert!(preview(&w, &i).is_err());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let wire = read_request(&mut stream).await;
        drop(stream);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
        wire
    });
    let (mut w, mut i) = fixture();
    w.bindings[0].base_url = format!("http://{address}");
    i.request.method = "POST".into();
    i.request.body_type = "multipart".into();
    i.request.form = vec![field("a", "one-write", "text")];
    assert!(execute(&w, i, CancellationToken::new()).await.is_err());
    assert!(String::from_utf8(handle.await.unwrap())
        .unwrap()
        .contains("one-write"));
}

#[test]
fn auth_credential_validation_matches_store_including_inactive_fields() {
    let (mut w, mut i) = fixture();
    set_variables(
        &mut w,
        vec![variable("project", "p", "secret", "value", false)],
    );
    for bad in ["{{secret\n}}", "{{\tsecret}}", "{{ secret\r\n }}"] {
        i.request.auth = auth(json!({"kind":"bearer","token":bad}));
        assert!(
            preview(&w, &i).is_err(),
            "control characters inside reference must reject"
        );
    }
    i.request.auth = auth(json!({"kind":"none","password":"private-plaintext"}));
    assert!(preview(&w, &i).is_err());
    i.request.auth = auth(json!({"kind":"none","location":"invalid"}));
    assert!(preview(&w, &i).is_err());
    for allowed in ["", "{{secret}}", "{{ secret }}"] {
        i.request.auth = auth(json!({"kind":"bearer","token":allowed}));
        assert!(preview(&w, &i).is_ok());
    }
}

#[tokio::test]
async fn production_confirmation_precedes_file_access_and_cancel_precedes_preparation() {
    let (mut w, mut i) = fixture();
    w.environments[0].is_production = true;
    i.request.body_type = "multipart".into();
    i.request.form = vec![field("f", "missing-private-file", "file")];
    let error = execute(&w, i.clone(), CancellationToken::new())
        .await
        .unwrap_err();
    assert!(error.contains("生产"), "{error}");
    let cancel = CancellationToken::new();
    cancel.cancel();
    let error = execute(&w, i, cancel).await.unwrap_err();
    assert!(error.contains("取消"), "{error}");
}

#[tokio::test]
async fn exact_single_and_total_file_limits_succeed() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ten-mib");
    std::fs::File::create(&path)
        .unwrap()
        .set_len(10 * 1024 * 1024)
        .unwrap();
    let form = super::super::upload::form(vec![field("f", path.to_str().unwrap(), "file"); 2])
        .await
        .unwrap();
    use futures_util::StreamExt;
    let mut stream = std::pin::pin!(form.into_stream());
    let mut bytes = 0;
    while let Some(chunk) = stream.next().await {
        bytes += chunk.unwrap().len();
    }
    assert!(bytes > 20 * 1024 * 1024);
    assert!(bytes < 20 * 1024 * 1024 + 1024);
}

#[cfg(windows)]
#[tokio::test]
async fn windows_parent_junction_is_rejected_without_exposing_target_path() {
    use std::os::windows::process::CommandExt;
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    std::fs::create_dir(&target).unwrap();
    std::fs::write(target.join("private-name"), b"secret-file").unwrap();
    let link = dir.path().join("link");
    // Junction creation is unprivileged and exercises Windows reparse-point
    // rejection even on machines without the symbolic-link privilege.
    let status = std::process::Command::new("powershell.exe")
        .args(["-NoProfile","-NonInteractive","-Command",
            "New-Item -ItemType Junction -Path $env:ENGINE_TEST_LINK -Target $env:ENGINE_TEST_TARGET -ErrorAction Stop | Out-Null"])
        .env("ENGINE_TEST_LINK",&link).env("ENGINE_TEST_TARGET",&target)
        .creation_flags(0x08000000).output().unwrap().status;
    assert!(status.success());
    let (w, mut i) = fixture();
    i.request.body_type = "multipart".into();
    i.request.form = vec![field(
        "f",
        link.join("private-name").to_str().unwrap(),
        "file",
    )];
    assert!(preview(&w, &i).is_ok());
    assert!(export_curl(&w, &i).is_ok());
    let error = execute(&w, i, CancellationToken::new()).await.unwrap_err();
    assert!(error.contains("重解析点"), "{error}");
    assert!(!error.contains("private"));
    // Explicitly remove only the junction, never recursively touch its target.
    std::fs::remove_dir(&link).unwrap();
    assert!(target.join("private-name").exists());
}

#[cfg(unix)]
#[tokio::test]
async fn unix_symlink_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("target");
    std::fs::write(&target, b"secret-file").unwrap();
    let link = dir.path().join("link");
    std::os::unix::fs::symlink(&target, &link).unwrap();
    assert!(
        super::super::upload::form(vec![field("f", link.to_str().unwrap(), "file")])
            .await
            .is_err()
    );
}

#[tokio::test]
async fn literal_credential_queries_are_masked_everywhere_except_actual_wire() {
    let keys = [
        "token",
        "access_token",
        "api_key",
        "password",
        "ACCESS-TOKEN",
        "refresh_token",
        "client_secret",
        "authorization",
    ];
    let (base, rx, handle) = server("200 OK", "", vec![], Duration::ZERO).await;
    let (mut w, mut i) = fixture();
    w.bindings[0].base_url = base;
    i.request.query = keys
        .iter()
        .enumerate()
        .map(|(n, key)| pair(key, &format!("manual-private-{n}")))
        .collect();
    i.request.query.push(pair("page", "2"));
    let preview_json = serde_json::to_string(&preview(&w, &i).unwrap()).unwrap();
    let curl = export_curl(&w, &i).unwrap();
    let response = execute(&w, i, CancellationToken::new()).await.unwrap();
    assert!(!preview_json.contains("manual-private"));
    assert!(!curl.contains("manual-private"));
    assert!(!response.url.contains("manual-private"));
    assert!(response.url.contains("page=2"));
    let wire = String::from_utf8(rx.await.unwrap()).unwrap();
    for n in 0..keys.len() {
        assert!(wire.contains(&format!("manual-private-{n}")));
    }
    handle.await.unwrap();
}

#[test]
fn credential_query_variable_is_also_masked_in_resolved_variables() {
    let (mut w, mut i) = fixture();
    set_variables(
        &mut w,
        vec![variable("project", "p", "v", "private-unmarked", false)],
    );
    i.request.query = vec![pair("access_token", "{{v}}")];
    i.request.body_type = "text".into();
    i.request.body = "{{v}}".into();
    assert!(!serde_json::to_string(&preview(&w, &i).unwrap())
        .unwrap()
        .contains("private-unmarked"));
    assert!(!export_curl(&w, &i).unwrap().contains("private-unmarked"));
    let prepared = prepare(&w, &i, Mode::Execute).unwrap();
    assert!(prepared.url.as_str().contains("private-unmarked"));
    assert_eq!(prepared.body.as_deref(), Some("private-unmarked"));
}

#[tokio::test]
async fn credential_form_fields_export_masked_but_send_real_values() {
    for body_type in ["form", "multipart"] {
        let (base, rx, handle) = server("200 OK", "", vec![], Duration::ZERO).await;
        let (mut w, mut i) = fixture();
        w.bindings[0].base_url = base;
        set_variables(
            &mut w,
            vec![variable("project", "p", "v", "private-unmarked", false)],
        );
        i.request.method = "POST".into();
        i.request.body_type = body_type.into();
        i.request.form = vec![
            field("password", "manual-private", "text"),
            field("access_token", "{{v}}", "text"),
            field("name", "ordinary", "text"),
        ];
        let curl = export_curl(&w, &i).unwrap();
        assert!(
            !curl.contains("manual-private"),
            "{body_type}: literal credential leaked"
        );
        assert!(
            !curl.contains("private-unmarked"),
            "{body_type}: credential reference leaked"
        );
        assert!(curl.contains("ordinary"));
        assert!(!serde_json::to_string(&preview(&w, &i).unwrap())
            .unwrap()
            .contains("private-unmarked"));
        execute(&w, i, CancellationToken::new()).await.unwrap();
        let wire = String::from_utf8(rx.await.unwrap()).unwrap();
        assert!(wire.contains("manual-private"));
        assert!(wire.contains("private-unmarked"));
        handle.await.unwrap();
    }
}
