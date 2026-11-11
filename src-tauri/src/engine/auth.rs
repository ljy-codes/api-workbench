use super::variables::{Variables, MASK};
use crate::models::AuthConfig;
use base64::{engine::general_purpose::STANDARD, Engine};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use url::Url;

fn credential_reference(value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Ok(());
    }
    let reference = value.strip_prefix("{{").and_then(|s| s.strip_suffix("}}"));
    if reference.is_some_and(|name| {
        !name.trim().is_empty() && !name.contains(['{', '}']) && !name.chars().any(char::is_control)
    }) {
        Ok(())
    } else {
        Err("鉴权凭据仅允许空值或完整的 {{变量名}} 引用".into())
    }
}

pub(super) fn protect(auth: Option<&AuthConfig>, vars: &mut Variables) -> Result<(), String> {
    let Some(auth) = auth else { return Ok(()) };
    if !matches!(auth.location.as_str(), "" | "header" | "query") {
        return Err("鉴权类型或位置无效".into());
    }
    // Validate all stored credential fields, but only resolve effective ones.
    for value in [&auth.token, &auth.password, &auth.value] {
        credential_reference(value)?;
    }
    match auth.kind.as_str() {
        "none" => Ok(()),
        "bearer" => vars.protect(&auth.token),
        "basic" => vars.protect(&auth.password),
        "apiKey" => vars.protect(&auth.value),
        _ => Err("鉴权类型无效".into()),
    }
}

fn no_controls(value: &str) -> Result<(), String> {
    if value.chars().any(char::is_control) {
        Err("鉴权字段禁止控制字符或 CR/LF 注入".into())
    } else {
        Ok(())
    }
}

pub(super) fn header_name(value: &str) -> Result<HeaderName, String> {
    let name = HeaderName::from_bytes(value.as_bytes()).map_err(|_| "请求 Header 名称无效")?;
    if matches!(
        name.as_str(),
        "host" | "content-length" | "transfer-encoding"
    ) {
        return Err("Host、Content-Length、Transfer-Encoding 由原生引擎管理".into());
    }
    Ok(name)
}

pub(super) fn sensitive_header(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "authorization"
            | "proxy-authorization"
            | "cookie"
            | "set-cookie"
            | "x-api-key"
            | "api-key"
            | "apikey"
            | "x-auth-token"
            | "x-access-token"
    )
}

pub(super) fn apply(
    auth: Option<&AuthConfig>,
    vars: &Variables,
    masked: bool,
    headers: &mut HeaderMap,
    url: &mut Url,
    redacted_url: &mut Url,
) -> Result<(), String> {
    apply_with(
        auth,
        masked,
        headers,
        url,
        redacted_url,
        |value, masked| vars.render(value, masked),
        |value| vars.header_name(value, masked),
    )
}

/// Direct credentials are allowed only for the standalone temporary IPC path.
/// Stored requests still call protect(), including inactive credential fields.
pub(super) fn apply_literal(
    auth: Option<&AuthConfig>,
    headers: &mut HeaderMap,
    url: &mut Url,
    redacted_url: &mut Url,
) -> Result<(), String> {
    if let Some(auth) = auth {
        if !matches!(auth.location.as_str(), "" | "header" | "query") {
            return Err("鉴权类型或位置无效".into());
        }
        for value in [
            &auth.token,
            &auth.username,
            &auth.password,
            &auth.key,
            &auth.value,
        ] {
            no_controls(value)?;
        }
    }
    apply_with(
        auth,
        false,
        headers,
        url,
        redacted_url,
        |value, _| Ok(value.to_owned()),
        |value| Ok(value.to_owned()),
    )
}

fn apply_with(
    auth: Option<&AuthConfig>,
    masked: bool,
    headers: &mut HeaderMap,
    url: &mut Url,
    redacted_url: &mut Url,
    render: impl Fn(&str, bool) -> Result<String, String>,
    render_header: impl Fn(&str) -> Result<String, String>,
) -> Result<(), String> {
    let Some(auth) = auth else { return Ok(()) };
    let (key, value) = match auth.kind.as_str() {
        "none" => return Ok(()),
        "bearer" => {
            let token = render(&auth.token, masked)?;
            no_controls(&token)?;
            ("authorization".into(), format!("Bearer {token}"))
        }
        "basic" => {
            let username = render(&auth.username, masked)?;
            let password = render(&auth.password, masked)?;
            no_controls(&username)?;
            no_controls(&password)?;
            if username.contains(':') {
                return Err("Basic 用户名不能包含冒号".into());
            }
            (
                "authorization".into(),
                if masked {
                    format!("Basic {MASK}")
                } else {
                    format!(
                        "Basic {}",
                        STANDARD.encode(format!("{username}:{password}"))
                    )
                },
            )
        }
        "apiKey" => {
            let key = if auth.location == "header" {
                render_header(&auth.key)?
            } else {
                render(&auth.key, masked)?
            };
            let value = render(&auth.value, masked)?;
            no_controls(&key)?;
            no_controls(&value)?;
            if key.is_empty() {
                return Err("API Key 名称不能为空".into());
            }
            match auth.location.as_str() {
                "header" => (key, value),
                "query" => {
                    if url.query_pairs().any(|(name, _)| name == key) {
                        return Err("鉴权 Query 与手工 Query 冲突".into());
                    }
                    url.query_pairs_mut().append_pair(&key, &value);
                    redacted_url
                        .query_pairs_mut()
                        .append_pair(&render(&auth.key, true)?, MASK);
                    return Ok(());
                }
                _ => return Err("API Key 位置只能为 header 或 query".into()),
            }
        }
        _ => return Err("鉴权类型无效".into()),
    };
    let name = header_name(&key)?;
    if headers.contains_key(&name) {
        return Err("鉴权 Header 与手工 Header 冲突".into());
    }
    let mut value =
        HeaderValue::from_str(&value).map_err(|_| "鉴权 Header 值无效，禁止 CR/LF 注入")?;
    value.set_sensitive(true);
    headers.insert(name, value);
    Ok(())
}
