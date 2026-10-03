use api_workbench_lib::{engine, models::*, store::Store};
use std::io::{Read, Write};
use std::net::TcpListener;
use tokio_util::sync::CancellationToken;

fn workspace(base: &str) -> Workspace {
    Workspace {
        projects: vec![Project {
            id: "p".into(),
            name: "本地集成".into(),
            active_environment_id: Some("dev".into()),
            color: None,
        }],
        environments: vec![
            Environment {
                id: "dev".into(),
                project_id: "p".into(),
                name: "开发".into(),
                is_production: false,
                color: None,
            },
            Environment {
                id: "prod".into(),
                project_id: "p".into(),
                name: "生产".into(),
                is_production: true,
                color: None,
            },
        ],
        services: vec![Service {
            id: "s".into(),
            project_id: "p".into(),
            name: "用户服务".into(),
            headers: vec![],
            auth: None,
        }],
        bindings: vec![
            Binding {
                id: "bd".into(),
                project_id: "p".into(),
                service_id: "s".into(),
                environment_id: "dev".into(),
                base_url: base.into(),
                enabled: true,
            },
            Binding {
                id: "bp".into(),
                project_id: "p".into(),
                service_id: "s".into(),
                environment_id: "prod".into(),
                base_url: "https://example.invalid/gateway".into(),
                enabled: true,
            },
        ],
        requests: vec![RequestDefinition {
            id: "r".into(),
            service_id: "s".into(),
            folder_id: None,
            name: "获取用户".into(),
            method: "GET".into(),
            path: "/users/{{userId}}".into(),
            query: vec![],
            headers: vec![],
            body_type: "none".into(),
            body: String::new(),
            timeout_ms: 3000,
            auth: None,
            form: vec![],
            environment_configs: None,
        }],
        variables: vec![Variable {
            id: "v".into(),
            project_id: "p".into(),
            scope: "project".into(),
            owner_id: "p".into(),
            name: "userId".into(),
            value: "a/b".into(),
            is_secret: false,
        }],
        active_project_id: Some("p".into()),
        ..Default::default()
    }
}

fn input(ws: &Workspace) -> ExecuteInput {
    ExecuteInput {
        execution_id: "integration-request".into(),
        environment_id: "dev".into(),
        request: ws.requests[0].clone(),
        temporary_variables: vec![],
        production_confirmed: false,
    }
}

#[test]
fn persisted_environment_switch_keeps_one_request_definition() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("workbench.db");
    {
        let store = Store::open(&path).unwrap();
        store
            .save(workspace("http://127.0.0.1:9999/gateway"))
            .unwrap();
    }
    let store = Store::open(&path).unwrap();
    let ws = store.load().unwrap();
    let dev = engine::preview(&ws, &input(&ws)).unwrap();
    assert_eq!(dev.url, "http://127.0.0.1:9999/gateway/users/a%2Fb");
    let mut prod_input = input(&ws);
    prod_input.environment_id = "prod".into();
    let prod = engine::preview(&ws, &prod_input).unwrap();
    assert_eq!(prod.url, "https://example.invalid/gateway/users/a%2Fb");
    assert!(prod.is_production);
    assert_eq!(ws.requests.len(), 1);
    assert!(ws.revision > 0);
}

#[tokio::test]
async fn saved_request_is_sent_natively_to_local_http_server() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .unwrap();
        let mut bytes = Vec::new();
        loop {
            let mut chunk = [0; 1024];
            let read = socket.read(&mut chunk).unwrap();
            bytes.extend_from_slice(&chunk[..read]);
            if read == 0 || bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
        }
        let received = String::from_utf8_lossy(&bytes);
        assert!(
            received.starts_with("GET /gateway/users/a%2Fb HTTP/1.1"),
            "{received}"
        );
        let body = r#"{"ok":true}"#;
        write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
    });
    let temp = tempfile::tempdir().unwrap();
    let store = Store::open(&temp.path().join("workbench.db")).unwrap();
    store
        .save(workspace(&format!("http://{address}/gateway")))
        .unwrap();
    let request_input = input(&store.load().unwrap());
    let ws = store.load_for_request(&request_input).unwrap();
    let result = engine::execute(&ws, request_input, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(result.status, 200);
    assert_eq!(result.body, r#"{"ok":true}"#);
    assert!(!result.truncated);
    server.join().unwrap();
}
