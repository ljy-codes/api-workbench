use super::prepare::Prepared;
use crate::models::{Pair, ResponseData};
use futures_util::StreamExt;
use tokio::time::Instant;

const PREVIEW_LIMIT: usize = 2 * 1024 * 1024;

/// Never format reqwest errors: their Display/source chain can embed the real
/// secret-bearing URL. Keep the boundary error categories intentionally coarse.
fn transport_error(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "请求整体超时".into()
    } else if error.is_connect() {
        "连接失败，请检查地址、DNS、网络或 TLS 证书".into()
    } else if error.is_body() || error.is_decode() {
        "响应正文接收失败，响应不完整".into()
    } else {
        "HTTP 传输失败（请求可能已送达，请勿盲目重发写操作）".into()
    }
}

pub(super) async fn send(
    prepared: Prepared,
    execution_id: String,
    started: Instant,
) -> Result<ResponseData, String> {
    // Explicit no-retry policy (reqwest 0.12 with retry support), a fresh
    // non-pooled HTTP/1 client and no redirects avoid transparent write replay,
    // including reuse of a stale pooled connection and HTTP/2 retry semantics.
    // TLS certificate and hostname checks remain ON. System proxy discovery is
    // disabled; a future explicit proxy feature must be designed separately.
    let client = reqwest::Client::builder()
        .use_rustls_tls()
        .danger_accept_invalid_certs(false)
        .danger_accept_invalid_hostnames(false)
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .http1_only()
        .pool_max_idle_per_host(0)
        .no_proxy()
        .timeout(prepared.timeout)
        .build()
        .map_err(|_| "原生 HTTP 客户端初始化失败")?;
    let mut builder = client
        .request(prepared.method, prepared.url)
        .headers(prepared.headers);
    if let Some(body) = prepared.body {
        builder = builder.body(body);
    }
    if let Some(fields) = prepared.multipart {
        builder = builder.multipart(super::upload::form(fields).await?);
    }
    let response = builder.send().await.map_err(transport_error)?;
    // Do not call error_for_status: 4xx/5xx are useful HTTP responses.
    let status = response.status();
    let headers = response
        .headers()
        .iter()
        .enumerate()
        .map(|(index, (name, value))| Pair {
            id: format!("response-header-{index}"),
            key: name.as_str().into(),
            value: String::from_utf8_lossy(value.as_bytes()).into_owned(),
            enabled: true,
        })
        .collect();
    let mut stream = response.bytes_stream();
    let mut size_bytes = 0_u64;
    let mut preview = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(transport_error)?;
        size_bytes = size_bytes
            .checked_add(chunk.len() as u64)
            .ok_or("响应计数超出支持范围")?;
        let keep = chunk.len().min(PREVIEW_LIMIT.saturating_sub(preview.len()));
        preview.extend_from_slice(&chunk[..keep]);
        // Count the entire chunk actually yielded by the body stream, including
        // its overflow, but never drain subsequent chunks after crossing the cap.
        // At exactly the cap, poll once more for EOF or overflow to avoid
        // falsely marking a complete, exactly-sized response as truncated.
        if size_bytes > PREVIEW_LIMIT as u64 {
            break;
        }
    }
    // Immediately release the body/connection, including for endless streams.
    // sizeBytes is RECEIVED bytes, not the remote body's total size or the
    // declared Content-Length; the last chunk can take it slightly over the cap.
    drop(stream);
    let mut truncated = size_bytes > preview.len() as u64;
    let mut body = String::from_utf8_lossy(&preview).into_owned();
    // Lossy decoding can expand bytes (one invalid byte -> 3 UTF-8 bytes).
    // The IPC preview string must also fit the advertised 2 MiB ceiling.
    if body.len() > PREVIEW_LIMIT {
        let mut end = PREVIEW_LIMIT;
        while !body.is_char_boundary(end) {
            end -= 1;
        }
        body.truncate(end);
        truncated = true;
    }
    Ok(ResponseData {
        execution_id,
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").into(),
        duration_ms: started.elapsed().as_millis().min(u64::MAX as u128) as u64,
        size_bytes,
        headers,
        body,
        truncated,
        environment_name: prepared.preview.environment_name,
        url: prepared.preview.url,
    })
}
