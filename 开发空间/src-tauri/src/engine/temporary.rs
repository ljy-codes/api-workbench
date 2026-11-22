//! Standalone literal requests. This module never accepts a Workspace or Store.
use super::{
    auth, body,
    prepare::{Mode, Prepared},
    url_builder,
    variables::MASK,
};
use crate::models::{Preview, TemporaryExecuteInput};
use percent_encoding::percent_decode_str;
use reqwest::{
    header::{HeaderMap, HeaderValue},
    Method,
};
use std::time::Duration;
use url::{Host, Url};

pub(super) const VALIDATION_ERROR: &str =
    "临时请求配置校验失败，请检查 URL、方法、Headers、鉴权及正文";

/// Validate before WHATWG parsing, which otherwise repairs ambiguous slashes,
/// dot segments, whitespace, escaped hostnames and non-canonical IPv4 forms.
fn full_url(value: &str) -> Result<Url, String> {
    const INVALID: &str = "临时请求 URL 无效，请填写明确的 HTTP/HTTPS 完整地址";
    if value.is_empty()
        || value
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control())
        || value.contains(['\\', '#'])
    {
        return Err(INVALID.into());
    }
    let bytes = value.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'%'
            && (index + 2 >= bytes.len()
                || !bytes[index + 1].is_ascii_hexdigit()
                || !bytes[index + 2].is_ascii_hexdigit())
        {
            return Err(INVALID.into());
        }
    }
    if percent_decode_str(value)
        .decode_utf8_lossy()
        .chars()
        .any(char::is_control)
    {
        return Err(INVALID.into());
    }
    let (scheme, rest) = value.split_once("://").ok_or(INVALID)?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return Err("临时请求仅支持 HTTP/HTTPS".into());
    }
    let authority_end = rest.find(['/', '?']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if authority.is_empty() || authority.contains(['@', '%', '{', '}']) || authority.ends_with(':')
    {
        return Err(INVALID.into());
    }
    let path = rest[authority_end..].split('?').next().unwrap_or("");
    url_builder::reject_traversal(path).map_err(|_| INVALID)?;
    let url = Url::parse(value).map_err(|_| INVALID)?;
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err(INVALID.into());
    }
    if let Some(Host::Ipv4(ip)) = url.host() {
        let raw_host = authority.split(':').next().unwrap_or("");
        if raw_host != ip.to_string() {
            return Err(INVALID.into());
        }
    }
    Ok(url)
}

/// Preserve the original spelling of every non-sensitive pair, including
/// duplicates, %20 versus '+', lowercase escapes and keys without '='.
fn redact_url(url: &Url) -> Url {
    let mut redacted = url.clone();
    if let Some(query) = url.query() {
        let mask: String = url::form_urlencoded::byte_serialize(MASK.as_bytes()).collect();
        let query = query
            .split('&')
            .map(|pair| {
                let key = pair.split_once('=').map_or(pair, |(key, _)| key);
                let decoded = percent_decode_str(&key.replace('+', " "))
                    .decode_utf8_lossy()
                    .into_owned();
                if url_builder::sensitive_query_key(&decoded) {
                    format!("{key}={mask}")
                } else {
                    pair.to_owned()
                }
            })
            .collect::<Vec<_>>()
            .join("&");
        redacted.set_query(Some(&query));
    }
    redacted
}

pub(super) fn prepare(input: &TemporaryExecuteInput, mode: Mode) -> Result<Prepared, String> {
    if input.execution_id.trim().is_empty()
        || input.execution_id.len() > 200
        || input.execution_id.chars().any(char::is_control)
    {
        return Err("执行 ID 无效".into());
    }
    let request = &input.request;
    if !(1..=300_000).contains(&request.timeout_ms) {
        return Err("请求整体超时必须为 1～300000 毫秒".into());
    }
    let method = Method::from_bytes(request.method.as_bytes()).map_err(|_| "HTTP 方法无效")?;
    if method == Method::CONNECT {
        return Err("当前引擎不支持 CONNECT 隧道请求".into());
    }
    let mut url = full_url(&request.url)?;
    if request.query.iter().any(|pair| pair.enabled) {
        let mut query = url.query_pairs_mut();
        for pair in request.query.iter().filter(|pair| pair.enabled) {
            if pair.key.chars().any(char::is_control) || pair.value.chars().any(char::is_control) {
                return Err("Query 禁止控制字符".into());
            }
            query.append_pair(&pair.key, &pair.value);
        }
    }
    let mut redacted_url = redact_url(&url);
    let mut headers = HeaderMap::new();
    for pair in request.headers.iter().filter(|pair| pair.enabled) {
        let name = auth::header_name(&pair.key)?;
        let mut value = HeaderValue::from_str(&pair.value)
            .map_err(|_| "请求 Header 值无效，禁止 CR/LF 注入")?;
        value.set_sensitive(auth::sensitive_header(&name));
        headers.append(name, value);
    }
    auth::apply_literal(
        request.auth.as_ref(),
        &mut headers,
        &mut url,
        &mut redacted_url,
    )?;
    let prepared_body = body::prepare(
        body::BodyInput {
            kind: &request.body_type,
            text: &request.body,
            fields: &request.form,
        },
        &mut headers,
        matches!(mode, Mode::Preview),
        |value| Ok(value.to_owned()),
        |_| Ok(()),
        |key| Ok(url_builder::sensitive_query_key(key)),
    )?;
    Ok(Prepared {
        url,
        method,
        headers,
        body: prepared_body.body,
        multipart: prepared_body.multipart,
        timeout: Duration::from_millis(request.timeout_ms),
        preview: Preview {
            url: redacted_url.into(),
            environment_name: "无环境".into(),
            service_name: "临时请求".into(),
            is_production: false,
            resolved_variables: vec![],
        },
    })
}
