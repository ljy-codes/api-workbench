use super::{
    auth, url_builder,
    variables::{Variables, MASK},
};
use crate::models::*;
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE};
use reqwest::Method;
use serde_json::Value;
use std::time::Duration;
use url::Url;

const MAX_TIMEOUT_MS: u64 = 300_000;

pub(super) struct Prepared {
    pub url: Url,
    pub method: Method,
    pub headers: HeaderMap,
    pub body: Option<String>,
    pub multipart: Option<Vec<FormField>>,
    pub timeout: Duration,
    pub preview: Preview,
}

pub(super) enum Mode {
    Preview,
    Execute,
}

fn exactly_one<'a, T>(
    mut items: impl Iterator<Item = &'a T>,
    error: &'static str,
) -> Result<&'a T, String> {
    let item = items.next().ok_or(error)?;
    if items.next().is_some() {
        return Err(error.into());
    }
    Ok(item)
}

/// IDs from IPC do not establish ownership. Resolve through the stored graph,
/// then permit an edited draft only within that existing request's service.
fn context<'a>(
    workspace: &'a Workspace,
    input: &ExecuteInput,
) -> Result<(&'a Project, &'a Service, &'a Environment, &'a Binding), String> {
    let active = workspace
        .active_project_id
        .as_deref()
        .filter(|id| !id.is_empty())
        .ok_or("尚未选择有效项目")?;
    let project = exactly_one(
        workspace.projects.iter().filter(|p| p.id == active),
        "当前项目不存在或不唯一",
    )?;
    if input.request.id.is_empty()
        || input.request.service_id.is_empty()
        || input.environment_id.is_empty()
        || input.execution_id.trim().is_empty()
    {
        return Err("请求、服务、环境和执行 ID 不能为空".into());
    }
    let saved_request = exactly_one(
        workspace
            .requests
            .iter()
            .filter(|r| r.id == input.request.id),
        "接口必须先保存，且接口 ID 必须唯一",
    )?;
    if saved_request.service_id != input.request.service_id {
        return Err("接口不能通过执行参数改变所属服务".into());
    }
    let service = exactly_one(
        workspace
            .services
            .iter()
            .filter(|s| s.id == input.request.service_id),
        "接口所属服务不存在或不唯一",
    )?;
    let environment = exactly_one(
        workspace
            .environments
            .iter()
            .filter(|e| e.id == input.environment_id),
        "请求环境不存在或不唯一",
    )?;
    if service.project_id != project.id || environment.project_id != project.id {
        return Err("接口服务与环境必须属于当前项目".into());
    }
    for folder_id in [
        saved_request.folder_id.as_deref(),
        input.request.folder_id.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        let folder = exactly_one(
            workspace
                .folders
                .iter()
                .filter(|folder| folder.id == folder_id),
            "接口目录不存在或不唯一",
        )?;
        if folder.service_id != service.id {
            return Err("接口目录不属于当前服务".into());
        }
    }
    let binding = exactly_one(
        workspace
            .bindings
            .iter()
            .filter(|b| b.service_id == service.id && b.environment_id == environment.id),
        "当前服务未配置此环境绑定，或存在重复绑定",
    )?;
    if binding.id.is_empty() || binding.project_id != project.id {
        return Err("服务环境绑定归属不合法".into());
    }
    if !binding.enabled {
        return Err("当前服务环境绑定已停用".into());
    }
    Ok((project, service, environment, binding))
}

fn replace_json_values(
    value: &mut Value,
    variables: &Variables,
    masked: bool,
) -> Result<(), String> {
    match value {
        Value::String(text) => *text = variables.render(text, masked)?,
        Value::Array(items) => {
            for item in items {
                replace_json_values(item, variables, masked)?;
            }
        }
        Value::Object(object) => {
            for (key, value) in object {
                if key.contains("{{") {
                    return Err("JSON 模式不支持键名占位符，请仅在字符串值中使用变量".into());
                }
                replace_json_values(value, variables, masked)?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub(super) fn prepare(
    workspace: &Workspace,
    input: &ExecuteInput,
    mode: Mode,
) -> Result<Prepared, String> {
    let masked = matches!(mode, Mode::Preview);
    let (project, service, environment, binding) = context(workspace, input)?;
    if !(1..=MAX_TIMEOUT_MS).contains(&input.request.timeout_ms) {
        return Err("请求整体超时必须为 1～300000 毫秒".into());
    }
    let timeout = Duration::from_millis(input.request.timeout_ms);
    let method =
        Method::from_bytes(input.request.method.as_bytes()).map_err(|_| "HTTP 方法无效")?;
    // CONNECT targets an authority instead of the validated origin path.
    if method == Method::CONNECT {
        return Err("当前引擎不支持 CONNECT 隧道请求".into());
    }
    let mut variables = Variables::resolve(
        workspace,
        &project.id,
        &service.id,
        &environment.id,
        &binding.id,
        &input.request.id,
        &input.temporary_variables,
    )?;
    let auth_config = input.request.auth.as_ref().or(service.auth.as_ref());
    auth::protect(auth_config, &mut variables)?;
    // A credential field is sensitive even when its referenced variable was
    // not explicitly classified in the editor. Protect resolvedVariables and
    // every masked rendering, without altering the actual transport values.
    for pair in input.request.query.iter().filter(|p| p.enabled) {
        if url_builder::sensitive_query_key(&variables.render(&pair.key, false)?) {
            variables.protect(&pair.value)?;
        }
    }
    if matches!(input.request.body_type.as_str(), "form" | "multipart") {
        for field in input
            .request
            .form
            .iter()
            .filter(|f| f.enabled && f.kind == "text")
        {
            if url_builder::sensitive_query_key(&variables.render(&field.key, false)?) {
                variables.protect(&field.value)?;
            }
        }
    }
    // Store::load intentionally omits decrypted values. Preview validates a
    // masked projection; execute always validates the actual values anew.
    let mut url = url_builder::build(
        &binding.base_url,
        &input.request.path,
        &input.request.query,
        &variables,
        masked,
    )?;
    let mut redacted_url = url_builder::build(
        &binding.base_url,
        &input.request.path,
        &input.request.query,
        &variables,
        true,
    )?;
    let mut headers = HeaderMap::new();
    let request_headers: Vec<_> = input
        .request
        .headers
        .iter()
        .filter(|p| p.enabled)
        .map(|pair| {
            variables
                .header_identity(&pair.key, masked)
                .map(|name| (pair, name))
        })
        .collect::<Result<_, _>>()?;
    // Override the complete service group before resolving its values. An
    // overridden default may refer to a missing/locked credential. Compare
    // expanded names case-insensitively, not their original template spelling.
    let mut inherited_headers = Vec::new();
    for pair in service.headers.iter().filter(|p| p.enabled) {
        // Exact templates are equivalent even when secret values are absent.
        // Do not fold template case: variable names themselves are case-sensitive.
        if request_headers.iter().any(|(r, _)| r.key == pair.key) {
            continue;
        }
        let name = variables.header_identity(&pair.key, masked)?;
        if name.as_ref().is_some_and(|name| {
            request_headers.iter().any(|(_, request_name)| {
                request_name
                    .as_ref()
                    .is_some_and(|request_name| request_name.eq_ignore_ascii_case(name))
            })
        }) {
            continue;
        }
        inherited_headers.push(pair);
    }
    for pair in inherited_headers
        .into_iter()
        .chain(request_headers.iter().map(|(pair, _)| *pair))
    {
        let key = variables.header_name(&pair.key, masked)?;
        let value = variables.render(&pair.value, masked)?;
        let name = auth::header_name(&key)?;
        let value =
            HeaderValue::from_str(&value).map_err(|_| "请求 Header 值无效，禁止 CR/LF 注入")?;
        let value = if masked && auth::sensitive_header(&name) {
            HeaderValue::from_str(MASK).map_err(|_| "脱敏 Header 构建失败")?
        } else {
            value
        };
        headers.append(name, value);
    }
    auth::apply(
        auth_config,
        &variables,
        masked,
        &mut headers,
        &mut url,
        &mut redacted_url,
    )?;
    let mut multipart = None;
    let body = match input.request.body_type.as_str() {
        "none" => None,
        "text" => Some(variables.render(&input.request.body, masked)?),
        "json" => {
            let mut value: Value = serde_json::from_str(&input.request.body)
                .map_err(|_| "JSON 正文无效；占位符只能放在 JSON 字符串值内")?;
            replace_json_values(&mut value, &variables, masked)?;
            if !headers.contains_key(CONTENT_TYPE) {
                headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
            }
            Some(serde_json::to_string(&value).map_err(|_| "JSON 正文序列化失败")?)
        }
        "form" | "multipart" => {
            let is_multipart = input.request.body_type == "multipart";
            let mut fields = Vec::new();
            for field in input.request.form.iter().filter(|f| f.enabled) {
                if !matches!(field.kind.as_str(), "text" | "file") {
                    return Err("表单字段类型只能为 text 或 file".into());
                }
                if field.kind == "file" && !is_multipart {
                    return Err("URL 编码表单不支持文件字段，请选择 multipart".into());
                }
                let key = variables.render(&field.key, masked)?;
                if key.chars().any(char::is_control) {
                    return Err("表单字段名称禁止控制字符或 CR/LF 注入".into());
                }
                // Never render, stat, open or read file paths in preview/export.
                let value = if field.kind == "file" && masked {
                    String::new()
                } else {
                    // Validate references first, even for wholly masked fields.
                    let value = variables.render(&field.value, masked)?;
                    if masked
                        && url_builder::sensitive_query_key(&variables.render(&field.key, false)?)
                    {
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
    Ok(Prepared {
        url,
        method,
        headers,
        body,
        multipart,
        timeout,
        preview: Preview {
            url: redacted_url.into(),
            environment_name: environment.name.clone(),
            service_name: service.name.clone(),
            is_production: environment.is_production,
            resolved_variables: variables.preview(),
        },
    })
}
