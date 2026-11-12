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

fn strip_json_comments(input: &str) -> Result<String, String> {
    let chars: Vec<char> = input.chars().collect();
    let mut output = String::with_capacity(input.len());
    let mut in_string = false;
    let mut escaped = false;
    let mut index = 0;
    let preserve = |output: &mut String, character: char| {
        if character == '\r' || character == '\n' {
            output.push(character);
        } else {
            output.push(' ');
        }
    };

    while index < chars.len() {
        let character = chars[index];
        if in_string {
            output.push(character);
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        if character == '"' {
            in_string = true;
            output.push(character);
            index += 1;
            continue;
        }
        if character == '/' && chars.get(index + 1) == Some(&'/') {
            preserve(&mut output, character);
            preserve(&mut output, '/');
            index += 2;
            while index < chars.len() && chars[index] != '\r' && chars[index] != '\n' {
                preserve(&mut output, chars[index]);
                index += 1;
            }
            continue;
        }
        if character == '/' && chars.get(index + 1) == Some(&'*') {
            preserve(&mut output, character);
            preserve(&mut output, '*');
            index += 2;
            let mut closed = false;
            while index < chars.len() {
                if chars[index] == '*' && chars.get(index + 1) == Some(&'/') {
                    preserve(&mut output, '*');
                    preserve(&mut output, '/');
                    index += 2;
                    closed = true;
                    break;
                }
                preserve(&mut output, chars[index]);
                index += 1;
            }
            if !closed {
                return Err("JSON 注释未闭合".into());
            }
            continue;
        }
        output.push(character);
        index += 1;
    }
    Ok(output)
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
            let normalized = strip_json_comments(input.text)?;
            let mut value: Value = serde_json::from_str(&normalized)
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

#[cfg(test)]
mod tests {
    use super::{prepare, strip_json_comments, BodyInput};
    use reqwest::header::HeaderMap;
    use serde_json::Value;

    #[test]
    fn strips_comments_without_touching_strings() {
        let source = r#"{
  // "disabled": "{{secret}}",
  "url": "https://example.test/a//b",
  "text": "/* keep this */"
}"#;
        let value: Value = serde_json::from_str(&strip_json_comments(source).unwrap()).unwrap();
        assert_eq!(value["url"], "https://example.test/a//b");
        assert_eq!(value["text"], "/* keep this */");
    }

    #[test]
    fn rejects_unclosed_comments() {
        let error = strip_json_comments(r#"{"enabled": true /* disabled"#).unwrap_err();
        assert_eq!(error, "JSON 注释未闭合");
    }

    #[test]
    fn commented_json_fields_are_removed_before_rendering_and_sending() {
        let mut headers = HeaderMap::new();
        let prepared = prepare(
            BodyInput {
                kind: "json",
                text: r#"{"enabled": true, // "secret": "{{missing}}"
}"#,
                fields: &[],
            },
            &mut headers,
            false,
            |_| panic!("commented JSON must not render variables"),
            |value| {
                assert!(!value.get("secret").is_some());
                Ok(())
            },
            |_| Ok(false),
        )
        .unwrap();
        assert_eq!(prepared.body.as_deref(), Some(r#"{"enabled":true}"#));
        assert_eq!(
            headers.get("content-type").and_then(|value| value.to_str().ok()),
            Some("application/json")
        );
    }
}
