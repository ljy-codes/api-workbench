use super::variables::{tokenize, Token, Variables, MASK};
use crate::models::Pair;
use percent_encoding::percent_decode_str;
use url::Url;

/// Only unreserved bytes are safe for a variable inside ONE path segment.
fn unreserved(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"-._~".contains(&byte)
}

fn push_encoded(result: &mut String, byte: u8) {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    result.push('%');
    result.push(HEX[(byte >> 4) as usize] as char);
    result.push(HEX[(byte & 15) as usize] as char);
}

fn encode_variable(value: &str) -> Result<String, String> {
    if value.contains('\\') || value.chars().any(char::is_control) {
        return Err("路径变量不能包含反斜线或控制字符".into());
    }
    let mut result = String::new();
    for byte in value.bytes() {
        if unreserved(byte) {
            result.push(byte as char);
        } else {
            push_encoded(&mut result, byte);
        }
    }
    Ok(result)
}

/// Keep valid static escapes byte-for-byte; never guess malformed `%` input.
fn encode_static(value: &str) -> Result<String, String> {
    let mut result = String::new();
    let bytes = value.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let byte = bytes[i];
        match byte {
            b'%' => {
                if i + 2 >= bytes.len()
                    || !bytes[i + 1].is_ascii_hexdigit()
                    || !bytes[i + 2].is_ascii_hexdigit()
                {
                    return Err("静态路径包含非法百分号编码".into());
                }
                result.push_str(&value[i..i + 3]);
                i += 3;
                continue;
            }
            b'\\' | b'?' | b'#' | 0..=31 | 127 => {
                return Err("路径不能包含反斜线、Query、fragment 或控制字符".into());
            }
            _ if unreserved(byte) || b"/!$&'()*+,;=:@".contains(&byte) => {
                result.push(byte as char);
            }
            _ => push_encoded(&mut result, byte),
        }
        i += 1;
    }
    Ok(result)
}

fn reject_traversal(path: &str) -> Result<(), String> {
    for segment in path.split('/') {
        let decoded = percent_decode_str(segment).collect::<Vec<u8>>();
        if decoded == b"." || decoded == b".." || decoded.contains(&b'\\') {
            return Err("路径不能包含点段或反斜线（包括编码形式）".into());
        }
    }
    Ok(())
}

fn base_url(value: &str) -> Result<Url, String> {
    if value.trim().is_empty() {
        return Err("当前服务环境绑定缺少基础地址".into());
    }
    if value.trim() != value
        || value.contains(['\\', '?', '#', '{', '}'])
        || value.chars().any(char::is_control)
    {
        return Err("基础地址格式无效，不允许凭据、Query、fragment 或模板".into());
    }
    let (scheme, rest) = value
        .split_once("://")
        .ok_or("基础地址必须使用 HTTP/HTTPS")?;
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return Err("基础地址必须使用 HTTP/HTTPS".into());
    }
    let (authority, path) = rest.split_once('/').map_or((rest, ""), |(a, p)| (a, p));
    if authority.is_empty() || authority.contains('@') {
        return Err("基础地址不允许空主机或 URL 用户凭据".into());
    }
    // Validate BEFORE Url::parse, which would normalize away traversal.
    let encoded = encode_static(path)?;
    reject_traversal(&encoded)?;
    let url = Url::parse(value).map_err(|_| "基础地址不是有效的 HTTP/HTTPS 地址")?;
    if url.host_str().is_none() || !url.username().is_empty() || url.password().is_some() {
        return Err("基础地址不允许空主机或 URL 用户凭据".into());
    }
    Ok(url)
}

fn render_path(template: &str, variables: &Variables, masked: bool) -> Result<String, String> {
    // One leading slash means append, NOT RFC relative resolution.
    if template.starts_with("//") || template.trim_start() != template {
        return Err("接口路径不能为绝对地址或 authority 路径".into());
    }
    let tokens = tokenize(template)?;
    // A colon in the first static segment denotes a scheme. Variable colons
    // are data and will be encoded, never inspected as generated templates.
    if let Some(Token::Literal(first)) = tokens.first() {
        if !first.starts_with('/') && first.split('/').next().unwrap_or("").contains(':') {
            return Err("接口路径不能为绝对地址".into());
        }
    }
    let mut path = String::new();
    for token in tokens {
        path.push_str(&match token {
            Token::Literal(value) => encode_static(value)?,
            Token::Variable(name) => encode_variable(variables.value(name, masked)?)?,
        });
    }
    reject_traversal(&path)?;
    Ok(path)
}

pub(super) fn sensitive_query_key(key: &str) -> bool {
    matches!(
        key.to_ascii_lowercase().replace('-', "_").as_str(),
        "token"
            | "access_token"
            | "refresh_token"
            | "id_token"
            | "api_key"
            | "apikey"
            | "authorization"
            | "password"
            | "passwd"
            | "secret"
            | "client_secret"
    )
}

pub(super) fn build(
    base: &str,
    path: &str,
    query: &[Pair],
    variables: &Variables,
    masked: bool,
) -> Result<Url, String> {
    let base = base_url(base)?;
    let path = render_path(path, variables, masked)?;
    let full_path = if path.is_empty() {
        base.path().to_owned()
    } else {
        format!(
            "{}/{}",
            base.path().trim_end_matches('/'),
            path.strip_prefix('/').unwrap_or(&path)
        )
    };
    reject_traversal(&full_path)?;
    let mut url = base.clone();
    url.set_path(&full_path);
    if url.path() != full_path || url.origin() != base.origin() {
        return Err("地址构建改变了路径结构或服务来源，已拒绝发送".into());
    }
    if query.iter().any(|pair| pair.enabled) {
        let mut pairs = url.query_pairs_mut();
        for pair in query.iter().filter(|pair| pair.enabled) {
            let key = variables.render(&pair.key, masked)?;
            // Validate referenced variables even if the entire value is later
            // hidden because the query key itself denotes a credential.
            let rendered_value = variables.render(&pair.value, masked)?;
            let value = if masked && sensitive_query_key(&variables.render(&pair.key, false)?) {
                MASK.to_owned()
            } else {
                rendered_value
            };
            pairs.append_pair(&key, &value);
        }
    }
    Ok(url)
}
