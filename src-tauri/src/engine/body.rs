//! Shared body validation/assembly; callers choose environment rendering or
//! literal input. File contents are read only by the cancellable transport.
use super::variables::MASK;
use crate::models::FormField;
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE};
use serde_json::Value;

pub(super) struct BodyInput<'a> {
    pub kind: &'a str,
    pub text: &'a str,
    pub fields: &'a [FormField],
}

pub(super) struct PreparedBody {
    pub body: Option<String>,
    pub multipart: Option<Vec<FormField>>,
}

pub(super) fn prepare(
    input: BodyInput<'_>,
    headers: &mut HeaderMap,
    masked: bool,
    render: impl Fn(&str) -> Result<String, String>,
    render_json: impl Fn(&mut Value) -> Result<(), String>,
    sensitive_field: impl Fn(&str) -> Result<bool, String>,
) -> Result<PreparedBody, String> {
    let mut multipart = None;
    let body = match input.kind {
        "none" => None,
        "text" => Some(render(input.text)?),
        "json" => {
            let mut value: Value = serde_json::from_str(input.text)
                .map_err(|_| "JSON 正文无效；占位符只能放在 JSON 字符串值内")?;
            render_json(&mut value)?;
            if !headers.contains_key(CONTENT_TYPE) {
                headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
            }
            Some(serde_json::to_string(&value).map_err(|_| "JSON 正文序列化失败")?)
        }
        "form" | "multipart" => {
            let is_multipart = input.kind == "multipart";
            let mut fields = Vec::new();
            for field in input.fields.iter().filter(|f| f.enabled) {
                if !matches!(field.kind.as_str(), "text" | "file") {
                    return Err("表单字段类型只能为 text 或 file".into());
                }
                if field.kind == "file" && !is_multipart {
                    return Err("URL 编码表单不支持文件字段，请选择 multipart".into());
                }
                let key = render(&field.key)?;
                if key.chars().any(char::is_control) {
                    return Err("表单字段名称禁止控制字符或 CR/LF 注入".into());
                }
                let value = if field.kind == "file" && masked {
                    String::new()
                } else {
                    let value = render(&field.value)?;
                    if masked && sensitive_field(&field.key)? {
                        MASK.to_owned()
                    } else {
                        value
                    }
                };
                fields.push(FormField {
                    key,
                    value,
                    ..field.clone()
                });
            }
            if is_multipart {
                if headers.contains_key(CONTENT_TYPE) {
                    return Err("multipart Content-Type 和 boundary 由原生引擎管理".into());
                }
                multipart = Some(fields);
                None
            } else {
                if !headers.contains_key(CONTENT_TYPE) {
                    headers.insert(
                        CONTENT_TYPE,
                        HeaderValue::from_static("application/x-www-form-urlencoded"),
                    );
                }
                Some(
                    url::form_urlencoded::Serializer::new(String::new())
                        .extend_pairs(fields.iter().map(|f| (&f.key, &f.value)))
                        .finish(),
                )
            }
        }
        _ => return Err("正文类型仅支持 none、json、text、form、multipart".into()),
    };
    Ok(PreparedBody { body, multipart })
}
