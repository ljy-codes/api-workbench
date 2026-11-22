use super::{
    prepare::{self, Mode},
    upload,
};
use crate::models::{ExecuteInput, Workspace};
use reqwest::header::CONTENT_TYPE;

/// POSIX single quotes, including the only character that can terminate one.
/// This string is never passed to a shell by the application.
fn quote(value: &str) -> Result<String, String> {
    if value.contains('\0') {
        return Err("cURL 导出不支持 NUL 字符".into());
    }
    Ok(format!("'{}'", value.replace('\'', "'\"'\"'")))
}

pub(super) fn export(workspace: &Workspace, input: &ExecuteInput) -> Result<String, String> {
    // Preview projection: no decrypted secrets or file I/O are required.
    let prepared = prepare::prepare(workspace, input, Mode::Preview)?;
    // curl --head cannot be combined with data/form options, even when empty.
    // This restriction belongs only to export, not native HEAD execution.
    if prepared.method == reqwest::Method::HEAD
        && (prepared.body.is_some() || prepared.multipart.is_some())
    {
        return Err("cURL 导出不支持带正文的 HEAD 请求，请将正文类型设为 none".into());
    }
    let mut parts = vec![
        "curl --http1.1 --globoff --path-as-is".to_string(),
        format!(
            "--max-time {}",
            quote(&format!("{:.3}", prepared.timeout.as_secs_f64()))?
        ),
        if prepared.method == reqwest::Method::HEAD {
            // --request HEAD only changes the verb; curl would still expect a
            // response body when a valid HEAD response carries Content-Length.
            "--head".into()
        } else {
            format!("--request {}", quote(prepared.method.as_str())?)
        },
        format!("--url {}", quote(&prepared.preview.url)?),
    ];
    for (name, value) in &prepared.headers {
        let value = std::str::from_utf8(value.as_bytes()).map_err(|_| "cURL Header 编码无效")?;
        // curl's "name:" removes a header; "name;" actually sends an empty one.
        let header = if value.is_empty() {
            format!("{name};")
        } else {
            format!("{name}: {value}")
        };
        parts.push(format!("--header {}", quote(&header)?));
    }
    if let Some(body) = prepared.body {
        if !prepared.headers.contains_key(CONTENT_TYPE) {
            // Match native text bodies, not curl's default form content type.
            parts.push("--header 'Content-Type:'".into());
        }
        // Unlike --data-binary, --data-raw NEVER reads an @-prefixed local file.
        parts.push(format!("--data-raw {}", quote(&body)?));
    }
    if let Some(fields) = prepared.multipart {
        for (index, field) in fields.iter().enumerate() {
            // Curl has its own multipart mini-language inside shell arguments.
            // Reject unsupported names rather than silently changing semantics.
            if field.key.contains(['=', ';', '"', '\\']) {
                return Err("cURL multipart 导出不支持字段名称中的 =、;、双引号或反斜线".into());
            }
            if field.kind == "file" {
                let part =
                    format!(
                    "{}=@/REPLACE/WITH/UPLOAD_FILE_{};filename={};type=application/octet-stream",
                    field.key, index + 1, upload::filename(index)
                );
                parts.push(format!("--form {}", quote(&part)?));
            } else {
                parts.push(format!(
                    "--form-string {}",
                    quote(&format!("{}={}", field.key, field.value))?
                ));
            }
        }
    }
    Ok(parts.join(" \\\n  "))
}
