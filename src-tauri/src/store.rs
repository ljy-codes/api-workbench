//! SQLite is the only persistent configuration source. All reads are snapshots;
//! full-workspace writes are a short IMMEDIATE transaction with revision CAS.
use crate::{models::*, secrets};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::Duration,
};

const INITIAL_SCHEMA: &str = include_str!("../migrations/001_initial.sql");
const V2_SCHEMA: &str = include_str!("../migrations/002_service_auth_form.sql");
const V3_SCHEMA: &str = include_str!("../migrations/003_environment_configs.sql");

mod responses;

pub struct Store {
    connection: Mutex<Connection>,
    path: PathBuf,
}

// Never forward raw SQL/OS errors: constraint messages, paths or custom triggers
// can contain user data. Errors deliberately identify the operation, not values.
fn db_error(_: rusqlite::Error) -> String {
    "SQLite 操作失败：请检查数据约束、文件权限或数据库占用；未提交的修改已回滚".to_string()
}

impl Store {
    pub fn open(path: &Path) -> Result<Store, String> {
        let path = std::path::absolute(path).map_err(|_| "无法确定数据库路径".to_string())?;
        // Use Path directly: lossy path conversion breaks Chinese Windows paths.
        let mut connection = Connection::open(&path).map_err(db_error)?;
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(db_error)?;
        connection
            .execute_batch(
                "PRAGMA foreign_keys=OFF; PRAGMA journal_mode=WAL;
             PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;",
            )
            .map_err(db_error)?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let has_migrations: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migration')",
            [], |r| r.get(0),
        ).map_err(db_error)?;
        if has_migrations {
            let (count, version): (i64, Option<i64>) = tx
                .query_row(
                    "SELECT count(*), max(version) FROM schema_migration",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .map_err(db_error)?;
            if count != 1 || !matches!(version, Some(1..=3)) {
                return Err(
                    "不支持此数据库 schema 版本，已停止打开；请使用匹配版本程序或一致性备份恢复"
                        .to_string(),
                );
            }
            validate_integrity(&tx)?;
            if matches!(version, Some(1 | 2)) {
                // Never back up the writing connection: SQLite returns LOCKED.
                // IMMEDIATE excludes other writers until backup + migration
                // commit, so this reader sees precisely the pre-upgrade state,
                // including committed pages still living in the WAL.
                let source = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
                    .map_err(db_error)?;
                backup_connection(&source, &path)?;
                if version == Some(1) {
                    tx.execute_batch(V2_SCHEMA).map_err(db_error)?;
                }
                tx.execute_batch(V3_SCHEMA).map_err(db_error)?;
            }
        } else {
            let count: i64 = tx
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
                    [],
                    |r| r.get(0),
                )
                .map_err(db_error)?;
            if count != 0 {
                return Err("数据库包含未识别的结构，禁止自动初始化或覆盖".to_string());
            }
            tx.execute_batch(INITIAL_SCHEMA).map_err(db_error)?;
            tx.execute_batch(V2_SCHEMA).map_err(db_error)?;
            tx.execute_batch(V3_SCHEMA).map_err(db_error)?;
        }
        validate_integrity(&tx)?;
        read_workspace(&tx, false)?;
        tx.commit().map_err(db_error)?;
        connection
            .execute_batch("PRAGMA foreign_keys=ON;")
            .map_err(db_error)?;
        Ok(Store {
            connection: Mutex::new(connection),
            path,
        })
    }

    /// A standalone, consistent SQLite snapshot next to the configured database.
    /// No decrypted secret or external destination is accepted.
    pub fn backup(&self) -> Result<PathBuf, String> {
        let mut connection = self.lock()?;
        let tx = connection.transaction().map_err(db_error)?;
        validate_integrity(&tx)?;
        read_workspace(&tx, false)?;
        let path = backup_connection(&tx, &self.path)?;
        tx.commit().map_err(db_error)?;
        Ok(path)
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>, String> {
        self.connection
            .lock()
            .map_err(|_| "存储锁异常，请重启应用后重试".to_string())
    }

    /// UI projection; encrypted bytes are not read or decrypted here.
    pub fn load(&self) -> Result<Workspace, String> {
        self.load_snapshot(false)
    }

    /// Legacy full-decryption snapshot. New request execution must use
    /// load_for_request so unrelated/overridden secrets never reach DPAPI.
    pub fn load_for_execution(&self) -> Result<Workspace, String> {
        self.load_snapshot(true)
    }

    /// Native-only snapshot for THIS input. Non-selected secrets retain their
    /// is_secret flag but have empty values; never expose this snapshot to UI or
    /// reuse it to execute a different input.
    pub fn load_for_request(&self, input: &ExecuteInput) -> Result<Workspace, String> {
        let mut connection = self.lock()?;
        let tx = connection.transaction().map_err(db_error)?;
        validate_integrity(&tx)?;
        let mut workspace = read_workspace(&tx, false)?;
        // Resolve ownership/priorities first. Header-name secrets may be needed
        // to determine which service values are actually overridden. Cache only
        // those selected names; never decrypt an overridden header's value.
        let mut header_secrets: HashMap<usize, String> = HashMap::new();
        let selected = request_secret_indices(&workspace, input, |index| {
            if let Some(value) = header_secrets.get(&index) {
                return Ok(value.clone());
            }
            let mut variable = workspace.variables[index].clone();
            decrypt_variable(&tx, &mut variable)?;
            header_secrets.insert(index, variable.value.clone());
            Ok(variable.value)
        })?;
        for index in selected {
            if let Some(value) = header_secrets.remove(&index) {
                workspace.variables[index].value = value;
            } else {
                decrypt_variable(&tx, &mut workspace.variables[index])?;
            }
        }
        tx.commit().map_err(db_error)?;
        Ok(workspace)
    }

    fn load_snapshot(&self, decrypt: bool) -> Result<Workspace, String> {
        let mut connection = self.lock()?;
        let tx = connection.transaction().map_err(db_error)?;
        validate_integrity(&tx)?;
        let workspace = read_workspace(&tx, decrypt)?;
        tx.commit().map_err(db_error)?;
        Ok(workspace)
    }

    pub fn save(&self, workspace: Workspace) -> Result<Workspace, String> {
        validate_v2_fields(&workspace)?;
        let revision = i64::try_from(workspace.revision)
            .map_err(|_| "revision 超出 SQLite 支持范围".to_string())?;
        let next = revision
            .checked_add(1)
            .ok_or_else(|| "revision 已达上限".to_string())?;
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        // Never repair an externally damaged graph via full replacement: a
        // previously loaded UI DTO may already have omitted its orphaned rows.
        validate_integrity(&tx)?;
        // SQL JSON checks cover syntax/container type, not DTO shape or credential
        // policy. Reject external damage before reserving a revision/deleting it.
        // Masked read only: even broken unrelated DPAPI bytes remain untouched.
        read_workspace(&tx, false)?;
        // Compare and reserve while holding the SQLite write lock, not before it.
        let updated = tx
            .execute(
                "UPDATE workspace_state SET revision=?1 WHERE singleton=1 AND revision=?2",
                params![next, revision],
            )
            .map_err(db_error)?;
        if updated != 1 {
            return Err("revision 冲突：配置已被修改，请重新加载后保存".to_string());
        }

        // Preserve ciphertext only, never decrypt secrets just to save a UI DTO.
        // An ID alone is not authorization to inherit another project's secret.
        let mut ciphertexts = HashMap::new();
        for variable in &workspace.variables {
            if !variable.is_secret {
                continue;
            }
            let previous: Option<(String, Vec<u8>)> = if variable.value.is_empty() {
                tx.query_row(
                    "SELECT project_id,ciphertext FROM secret WHERE variable_id=?1",
                    [&variable.id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(db_error)?
            } else {
                None
            };
            let ciphertext = match previous {
                Some((project_id, ciphertext)) if project_id == variable.project_id => ciphertext,
                Some(_) => {
                    return Err(
                        "敏感变量已改变所属项目，必须重新输入敏感值，不能继承原项目密文"
                            .to_string(),
                    )
                }
                None => secrets::protect(&variable.value)?,
            };
            ciphertexts.insert(variable.id.as_str(), ciphertext);
        }

        // Child-first replacement inside this transaction. Folder parents and
        // variable->secret links are deferred, permitting arbitrary DTO ordering.
        tx.execute_batch(
            "UPDATE workspace_state SET active_project_id=NULL WHERE singleton=1;
             DELETE FROM variable;
             DELETE FROM variable_scope;
             DELETE FROM request;
             DELETE FROM folder;
             DELETE FROM service_environment;
             DELETE FROM project_state;
             DELETE FROM service;
             DELETE FROM environment;
             DELETE FROM project;",
        )
        .map_err(db_error)?;
        write_workspace(&tx, &workspace, &ciphertexts)?;
        responses::remove_orphans(&tx)?;
        tx.execute(
            "UPDATE workspace_state SET active_project_id=?1 WHERE singleton=1",
            [&workspace.active_project_id],
        )
        .map_err(db_error)?;
        // Read back before commit so the returned DTO is precisely this revision
        // and any read/constraint/serialization error still rolls back all writes.
        validate_integrity(&tx)?;
        let result = read_workspace(&tx, false)?;
        tx.commit().map_err(db_error)?;
        Ok(result)
    }
}

fn backup_connection(source: &Connection, database_path: &Path) -> Result<PathBuf, String> {
    use std::{
        fs,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);
    let failed =
        || "SQLite 一致性备份失败；未执行升级，请检查备份目录权限、空间或数据库占用".to_string();
    let directory = database_path.parent().ok_or_else(failed)?.join("backups");
    fs::create_dir_all(&directory).map_err(|_| failed())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| failed())?
        .as_nanos();
    let mut reserved = None;
    for _ in 0..32 {
        let path = directory.join(format!(
            "workspace-{stamp}-{}-{}.sqlite",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(file) => {
                drop(file);
                reserved = Some(path);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(failed()),
        }
    }
    let path = reserved.ok_or_else(failed)?;
    let result = (|| -> Result<(), String> {
        let mut destination = Connection::open(&path).map_err(db_error)?;
        destination
            .execute_batch("PRAGMA synchronous=FULL;")
            .map_err(db_error)?;
        {
            let backup =
                rusqlite::backup::Backup::new(source, &mut destination).map_err(db_error)?;
            // One step holds a source read snapshot; fail rather than retry
            // indefinitely on a busy/locked database.
            if backup.step(-1).map_err(db_error)? != rusqlite::backup::StepResult::Done {
                return Err(failed());
            }
        }
        destination
            .execute_batch("PRAGMA journal_mode=DELETE;")
            .map_err(db_error)?;
        let tx = destination.transaction().map_err(db_error)?;
        validate_integrity(&tx)?;
        tx.commit().map_err(db_error)?;
        destination.close().map_err(|_| failed())?;
        fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .and_then(|file| file.sync_all())
            .map_err(|_| failed())?;
        Ok(())
    })();
    if result.is_err() {
        // Only the exclusively reserved file belongs to this operation.
        let _ = fs::remove_file(&path);
        return Err(failed());
    }
    Ok(path)
}

fn validate_auth(auth: Option<&AuthConfig>) -> Result<(), String> {
    let Some(auth) = auth else {
        return Ok(());
    };
    if !matches!(auth.kind.as_str(), "none" | "bearer" | "basic" | "apiKey")
        || !matches!(auth.location.as_str(), "" | "header" | "query")
    {
        return Err("鉴权类型或位置无效".into());
    }
    // Validate even inactive fields: none/basic must not be a plaintext hiding
    // place. Username/key are intentionally allowed to contain literals.
    for value in [&auth.token, &auth.password, &auth.value] {
        if value.is_empty() {
            continue;
        }
        let reference = value.strip_prefix("{{").and_then(|s| s.strip_suffix("}}"));
        if !reference.is_some_and(|name| {
            !name.trim().is_empty()
                && !name.contains(['{', '}'])
                && !name.chars().any(char::is_control)
        }) {
            return Err("鉴权凭据只能为空或完整的 {{变量名}} 引用，请在敏感变量中保存凭据".into());
        }
    }
    Ok(())
}

fn validate_v2_fields(workspace: &Workspace) -> Result<(), String> {
    for color in workspace
        .projects
        .iter()
        .map(|p| &p.color)
        .chain(workspace.environments.iter().map(|e| &e.color))
        .flatten()
    {
        if color.len() != 7
            || !color.starts_with('#')
            || !color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
        {
            return Err("颜色必须为 #RRGGBB 格式".into());
        }
    }
    for service in &workspace.services {
        validate_auth(service.auth.as_ref())?;
        let mut ids = HashSet::new();
        if service
            .headers
            .iter()
            .any(|p| p.id.trim().is_empty() || !ids.insert(&p.id))
        {
            return Err("服务 Header 存在空 ID 或重复 ID".into());
        }
    }
    for request in &workspace.requests {
        validate_request_environment_configs(workspace, request)?;
        validate_auth(request.auth.as_ref())?;
        let mut ids = HashSet::new();
        if request.form.iter().any(|f| {
            f.id.trim().is_empty()
                || !ids.insert(&f.id)
                || !matches!(f.kind.as_str(), "text" | "file")
        }) {
            return Err("表单存在空 ID、重复 ID 或无效类型".into());
        }
    }
    Ok(())
}

/// Validate even inactive overrides, so a foreign key cannot hide until an
/// environment switch. The resolved IPC top-level draft remains authoritative.
pub(crate) fn validate_request_environment_configs(
    workspace: &Workspace,
    request: &RequestDefinition,
) -> Result<(), String> {
    let Some(configs) = &request.environment_configs else {
        return Ok(());
    };
    let service = workspace
        .services
        .iter()
        .find(|s| s.id == request.service_id)
        .ok_or("接口引用的服务不存在")?;
    for (environment_id, config) in configs {
        if !workspace
            .environments
            .iter()
            .any(|e| e.id == *environment_id && e.project_id == service.project_id)
        {
            return Err("环境配置必须引用接口所属项目的有效环境".into());
        }
        if !(1..=300_000).contains(&config.timeout_ms)
            || !matches!(
                config.body_type.as_str(),
                "none" | "json" | "text" | "form" | "multipart"
            )
        {
            return Err("环境配置正文类型或超时无效（1～300000 毫秒）".into());
        }
        validate_auth(config.auth.as_ref())?;
        for pairs in [&config.query, &config.headers] {
            let mut ids = HashSet::new();
            if pairs
                .iter()
                .any(|p| p.id.trim().is_empty() || !ids.insert(&p.id))
            {
                return Err("环境配置参数存在空 ID 或重复 ID".into());
            }
        }
        let mut ids = HashSet::new();
        if config.form.iter().any(|f| {
            f.id.trim().is_empty()
                || !ids.insert(&f.id)
                || !matches!(f.kind.as_str(), "text" | "file")
        }) {
            return Err("环境配置表单存在空 ID、重复 ID 或无效类型".into());
        }
    }
    Ok(())
}

/// Keep this small native selector independent of engine. Scope priority and
/// template rules intentionally mirror its contract (not rendered output).
fn request_secret_indices(
    workspace: &Workspace,
    input: &ExecuteInput,
    mut secret_value: impl FnMut(usize) -> Result<String, String>,
) -> Result<Vec<usize>, String> {
    validate_request_environment_configs(workspace, &input.request)?;
    let project = workspace
        .active_project_id
        .as_deref()
        .and_then(|id| workspace.projects.iter().find(|project| project.id == id))
        .ok_or("尚未选择有效项目")?;
    if input.execution_id.trim().is_empty()
        || input.request.id.is_empty()
        || input.request.service_id.is_empty()
        || input.environment_id.is_empty()
    {
        return Err("请求、服务、环境和执行 ID 不能为空".into());
    }
    let saved = workspace
        .requests
        .iter()
        .find(|r| r.id == input.request.id)
        .ok_or("接口必须先保存")?;
    if saved.service_id != input.request.service_id {
        return Err("接口不能通过执行参数改变所属服务".into());
    }
    let service = workspace
        .services
        .iter()
        .find(|s| s.id == saved.service_id)
        .ok_or("接口所属服务不存在")?;
    let environment = workspace
        .environments
        .iter()
        .find(|e| e.id == input.environment_id)
        .ok_or("请求环境不存在")?;
    if service.project_id != project.id || environment.project_id != project.id {
        return Err("接口服务与环境必须属于当前项目".into());
    }
    for folder_id in [
        saved.folder_id.as_deref(),
        input.request.folder_id.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        if !workspace
            .folders
            .iter()
            .any(|f| f.id == folder_id && f.service_id == service.id)
        {
            return Err("接口目录不存在或不属于当前服务".into());
        }
    }
    let binding = workspace
        .bindings
        .iter()
        .find(|b| {
            b.project_id == project.id
                && b.service_id == service.id
                && b.environment_id == environment.id
        })
        .ok_or("当前服务未配置此环境绑定")?;
    if !binding.enabled {
        return Err("当前服务环境绑定已停用".into());
    }

    // Retain the whole masked graph so lower-scope secret flags still propagate
    // to preview/redaction in engine. Only the winning VALUE requires decryption.
    let mut winners = HashMap::new();
    for (scope, owner) in [
        ("project", project.id.as_str()),
        ("service", service.id.as_str()),
        ("environment", environment.id.as_str()),
        ("binding", binding.id.as_str()),
        ("request", saved.id.as_str()),
    ] {
        let mut names = HashSet::new();
        for (index, variable) in
            workspace.variables.iter().enumerate().filter(|(_, v)| {
                v.project_id == project.id && v.scope == scope && v.owner_id == owner
            })
        {
            if variable.name.trim().is_empty() || !names.insert(variable.name.as_str()) {
                return Err("同一作用域存在空名称或重复变量".into());
            }
            winners.insert(variable.name.as_str(), Some(index));
        }
    }
    let mut temporary_values = HashMap::new();
    for pair in input.temporary_variables.iter().filter(|p| p.enabled) {
        if pair.key.trim().is_empty()
            || temporary_values
                .insert(pair.key.as_str(), pair.value.as_str())
                .is_some()
        {
            return Err("本次临时变量存在空名称或重复名称".into());
        }
        // Empty enabled values are real overrides, not inheritance requests.
        winners.insert(pair.key.as_str(), None);
    }
    let mut selected = Vec::new();
    for name in request_template_names(&input.request, service, |name| match winners.get(name) {
        Some(Some(index)) => {
            let variable = &workspace.variables[*index];
            if variable.is_secret {
                secret_value(*index)
            } else {
                Ok(variable.value.clone())
            }
        }
        Some(None) => Ok(temporary_values[name].to_string()),
        None => Err("缺少模板引用的变量，请检查当前环境及变量作用域".into()),
    })? {
        match winners.get(name.as_str()) {
            Some(Some(index)) if workspace.variables[*index].is_secret => selected.push(*index),
            Some(_) => {}
            None => return Err("缺少模板引用的变量，请检查当前环境及变量作用域".into()),
        }
    }
    Ok(selected)
}

fn request_template_names(
    request: &RequestDefinition,
    service: &Service,
    mut header_value: impl FnMut(&str) -> Result<String, String>,
) -> Result<HashSet<String>, String> {
    let mut names = HashSet::new();
    collect_template_names(&request.path, &mut names)?;
    for pair in request
        .query
        .iter()
        .chain(&request.headers)
        .filter(|p| p.enabled)
    {
        collect_template_names(&pair.key, &mut names)?;
        collect_template_names(&pair.value, &mut names)?;
    }
    let auth = request.auth.as_ref().or(service.auth.as_ref());
    validate_auth(auth)?;
    if let Some(auth) = auth {
        let values: Vec<&str> = match auth.kind.as_str() {
            "bearer" => vec![&auth.token],
            "basic" => vec![&auth.username, &auth.password],
            "apiKey" => vec![&auth.key, &auth.value],
            _ => vec![],
        };
        for value in values {
            collect_template_names(value, &mut names)?;
        }
    }
    match request.body_type.as_str() {
        "none" => {}
        "text" => collect_template_names(&request.body, &mut names)?,
        "form" | "multipart" => {
            for field in request.form.iter().filter(|f| f.enabled) {
                collect_template_names(&field.key, &mut names)?;
                match field.kind.as_str() {
                    "text" => collect_template_names(&field.value, &mut names)?,
                    // Execution expands file paths; preview/export do not open
                    // them. Select references from the original template only.
                    "file" if request.body_type == "multipart" => {
                        collect_template_names(&field.value, &mut names)?;
                    }
                    _ => return Err("表单字段类型无效；form 仅支持文本字段".into()),
                }
            }
        }
        "json" => {
            // Parse first: escaped Unicode may form a token, duplicate JSON keys
            // are resolved by serde_json, and non-string values aren't templates.
            let body: serde_json::Value = serde_json::from_str(&request.body)
                .map_err(|_| "JSON 正文无效；占位符只能放在 JSON 字符串值内")?;
            let mut pending = vec![&body];
            while let Some(value) = pending.pop() {
                match value {
                    serde_json::Value::String(text) => collect_template_names(text, &mut names)?,
                    serde_json::Value::Array(items) => pending.extend(items),
                    serde_json::Value::Object(object) => {
                        for (key, value) in object {
                            if key.contains("{{") {
                                return Err(
                                    "JSON 模式不支持键名占位符，请仅在字符串值中使用变量".into()
                                );
                            }
                            pending.push(value);
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => return Err("正文类型仅支持 none、json、text、form、multipart".into()),
    }
    // Compare the effective ASCII-case-insensitive names, not their templates.
    // Do not scan service values until after the entire overridden group is
    // excluded; missing/corrupt secrets inside those values must remain unused.
    let mut overrides = HashSet::new();
    for pair in request.headers.iter().filter(|p| p.enabled) {
        overrides.insert(expanded_header_name(
            &pair.key,
            &mut names,
            &mut header_value,
        )?);
    }
    for pair in service.headers.iter().filter(|p| p.enabled) {
        let key = expanded_header_name(&pair.key, &mut names, &mut header_value)?;
        if !overrides.contains(&key) {
            collect_template_names(&pair.value, &mut names)?;
        }
    }
    // Base URL/method/name are not templates in the current engine contract.
    Ok(names)
}

fn expanded_header_name(
    template: &str,
    names: &mut HashSet<String>,
    value: &mut impl FnMut(&str) -> Result<String, String>,
) -> Result<String, String> {
    collect_template_names(template, names)?;
    let mut rendered = String::new();
    let mut remaining = template;
    while let Some(start) = remaining.find("{{") {
        rendered.push_str(&remaining[..start]);
        let after_open = &remaining[start + 2..];
        let end = after_open.find("}}").ok_or("变量占位符未闭合")?;
        rendered.push_str(&value(after_open[..end].trim())?);
        remaining = &after_open[end + 2..];
    }
    rendered.push_str(remaining);
    // Only original-template tokens are expanded: replacement text is literal.
    Ok(rendered.to_ascii_lowercase())
}

fn collect_template_names(template: &str, names: &mut HashSet<String>) -> Result<(), String> {
    let mut remaining = template;
    while let Some(start) = remaining.find("{{") {
        let after_open = &remaining[start + 2..];
        let end = after_open.find("}}").ok_or("变量占位符未闭合")?;
        let name = after_open[..end].trim();
        if name.is_empty() || name.contains(['{', '}']) || name.chars().any(char::is_control) {
            return Err("变量占位符名称无效".into());
        }
        names.insert(name.to_string());
        remaining = &after_open[end + 2..];
    }
    Ok(())
}

fn decrypt_variable(connection: &Connection, variable: &mut Variable) -> Result<(), String> {
    let ciphertext: Vec<u8> = connection
        .query_row(
            "SELECT ciphertext FROM secret WHERE variable_id=?1 AND project_id=?2",
            params![variable.id, variable.project_id],
            |r| r.get(0),
        )
        .map_err(db_error)?;
    variable.value = secrets::unprotect(&ciphertext)?;
    Ok(())
}

/// Caller must already hold a read/write transaction so validation and subsequent
/// reads/writes see one SQLite snapshot. No repair, deletion, or DPAPI operation.
fn validate_integrity(connection: &Connection) -> Result<(), String> {
    let damaged =
        || "SQLite 数据完整性校验失败，已停止读取或保存；请保留原库并从一致性备份恢复".to_string();
    let check: String = connection
        .query_row("PRAGMA quick_check(1)", [], |r| r.get(0))
        .map_err(db_error)?;
    if check != "ok" {
        return Err(damaged());
    }
    let broken_foreign_key: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_check)",
            [],
            |r| r.get(0),
        )
        .map_err(db_error)?;
    // Foreign keys do not enforce reverse existence of required state rows.
    let missing_state: bool = connection
        .query_row(
            "SELECT (SELECT count(*) FROM workspace_state WHERE singleton=1) <> 1
             OR (SELECT count(*) FROM schema_migration) <> 1
             OR NOT EXISTS(SELECT 1 FROM schema_migration WHERE version IN (1,2,3))
             OR EXISTS(SELECT 1 FROM project p
                       LEFT JOIN project_state s ON s.project_id=p.id
                       WHERE s.project_id IS NULL)",
            [],
            |r| r.get(0),
        )
        .map_err(db_error)?;
    if broken_foreign_key || missing_state {
        return Err(damaged());
    }
    // Existing cycles are not reported by foreign_key_check/quick_check and may
    // have been written with a disabled/dropped trigger. Iterative O(n), no
    // recursive stack growth for deep folder trees.
    let folders: HashMap<String, Option<String>> =
        read_rows(connection, "SELECT id,parent_id FROM folder", |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?
        .into_iter()
        .collect();
    let mut checked = HashSet::new();
    for id in folders.keys() {
        let mut chain = HashSet::new();
        let mut current = Some(id.as_str());
        while let Some(id) = current {
            if checked.contains(id) {
                break;
            }
            if !chain.insert(id) {
                return Err(damaged());
            }
            current = folders.get(id).and_then(|parent| parent.as_deref());
        }
        checked.extend(chain);
    }
    Ok(())
}

fn read_rows<T>(
    connection: &Connection,
    sql: &str,
    map: impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>, String> {
    let mut statement = connection.prepare(sql).map_err(db_error)?;
    let rows = statement.query_map([], map).map_err(db_error)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_error)
}

fn read_pairs(connection: &Connection, request_id: &str, kind: &str) -> Result<Vec<Pair>, String> {
    let mut statement = connection.prepare(
        "SELECT id,key,value,enabled FROM request_pair WHERE request_id=?1 AND kind=?2 ORDER BY position"
    ).map_err(db_error)?;
    let rows = statement
        .query_map(params![request_id, kind], |r| {
            Ok(Pair {
                id: r.get(0)?,
                key: r.get(1)?,
                value: r.get(2)?,
                enabled: r.get(3)?,
            })
        })
        .map_err(db_error)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_error)
}

fn json_column<T: serde::de::DeserializeOwned>(
    row: &rusqlite::Row<'_>,
    index: usize,
) -> rusqlite::Result<T> {
    let text: String = row.get(index)?;
    serde_json::from_str(&text).map_err(|_| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "配置 JSON 无效",
            )),
        )
    })
}

fn json_value<T: serde::Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|_| "配置 JSON 序列化失败".into())
}

fn read_workspace(connection: &Connection, decrypt: bool) -> Result<Workspace, String> {
    let (revision, active_project_id) = connection
        .query_row(
            "SELECT revision,active_project_id FROM workspace_state WHERE singleton=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(db_error)?;
    let projects = read_rows(connection,
        "SELECT p.id,p.name,s.environment_id,p.color FROM project p LEFT JOIN project_state s ON s.project_id=p.id ORDER BY p.position",
        |r| Ok(Project { id:r.get(0)?, name:r.get(1)?, active_environment_id:r.get(2)?, color:r.get(3)? }))?;
    let environments = read_rows(
        connection,
        "SELECT id,project_id,name,is_production,color FROM environment ORDER BY position",
        |r| {
            Ok(Environment {
                id: r.get(0)?,
                project_id: r.get(1)?,
                name: r.get(2)?,
                is_production: r.get(3)?,
                color: r.get(4)?,
            })
        },
    )?;
    let services = read_rows(
        connection,
        "SELECT id,project_id,name,headers,auth FROM service ORDER BY position",
        |r| {
            Ok(Service {
                id: r.get(0)?,
                project_id: r.get(1)?,
                name: r.get(2)?,
                headers: json_column(r, 3)?,
                auth: json_column(r, 4)?,
            })
        },
    )?;
    let bindings = read_rows(connection,
        "SELECT id,project_id,service_id,environment_id,base_url,enabled FROM service_environment ORDER BY position",
        |r| Ok(Binding { id:r.get(0)?, project_id:r.get(1)?, service_id:r.get(2)?, environment_id:r.get(3)?, base_url:r.get(4)?, enabled:r.get(5)? }))?;
    let folders = read_rows(
        connection,
        "SELECT id,service_id,parent_id,name FROM folder ORDER BY position",
        |r| {
            Ok(Folder {
                id: r.get(0)?,
                service_id: r.get(1)?,
                parent_id: r.get(2)?,
                name: r.get(3)?,
            })
        },
    )?;
    let mut requests = read_rows(connection,
        "SELECT id,service_id,folder_id,name,method,path,body_type,body,timeout_ms,auth,form,environment_configs FROM request ORDER BY position",
        |r| Ok(RequestDefinition {
            id:r.get(0)?, service_id:r.get(1)?, folder_id:r.get(2)?, name:r.get(3)?,
            method:r.get(4)?, path:r.get(5)?, body_type:r.get(6)?, body:r.get(7)?,
            timeout_ms:r.get(8)?, query:Vec::new(), headers:Vec::new(),
            auth:json_column(r, 9)?, form:json_column(r, 10)?,
            environment_configs:json_column(r, 11)?,
        }))?;
    for request in &mut requests {
        request.query = read_pairs(connection, &request.id, "query")?;
        request.headers = read_pairs(connection, &request.id, "header")?;
    }
    let variables = read_rows(
        connection,
        "SELECT v.id,v.project_id,s.kind,s.owner_id,v.name,
                CASE WHEN v.is_secret=1 THEN '' ELSE v.value END,v.is_secret
         FROM variable v JOIN variable_scope s ON s.id=v.scope_id ORDER BY v.position",
        |r| {
            Ok(Variable {
                id: r.get(0)?,
                project_id: r.get(1)?,
                scope: r.get(2)?,
                owner_id: r.get(3)?,
                name: r.get(4)?,
                value: r.get(5)?,
                is_secret: r.get(6)?,
            })
        },
    )?;
    let mut workspace = Workspace {
        revision,
        active_project_id,
        projects,
        environments,
        services,
        bindings,
        folders,
        requests,
        variables,
    };
    validate_v2_fields(&workspace)?;
    if decrypt {
        for variable in &mut workspace.variables {
            if variable.is_secret {
                decrypt_variable(connection, variable)?;
            }
        }
    }
    Ok(workspace)
}

fn position(index: usize) -> Result<i64, String> {
    i64::try_from(index).map_err(|_| "工作区条目过多".to_string())
}

fn write_workspace(
    connection: &Connection,
    workspace: &Workspace,
    ciphertexts: &HashMap<&str, Vec<u8>>,
) -> Result<(), String> {
    for (index, project) in workspace.projects.iter().enumerate() {
        connection
            .execute(
                "INSERT INTO project(id,name,position,color) VALUES (?1,?2,?3,?4)",
                params![project.id, project.name, position(index)?, project.color],
            )
            .map_err(db_error)?;
    }
    for (index, environment) in workspace.environments.iter().enumerate() {
        connection.execute(
            "INSERT INTO environment(id,project_id,name,is_production,position,color) VALUES (?1,?2,?3,?4,?5,?6)",
            params![environment.id, environment.project_id, environment.name, environment.is_production, position(index)?, environment.color],
        ).map_err(db_error)?;
    }
    for project in &workspace.projects {
        connection
            .execute(
                "INSERT INTO project_state(project_id,environment_id) VALUES (?1,?2)",
                params![project.id, project.active_environment_id],
            )
            .map_err(db_error)?;
    }
    for (index, service) in workspace.services.iter().enumerate() {
        connection
            .execute(
                "INSERT INTO service(id,project_id,name,position,headers,auth) VALUES (?1,?2,?3,?4,?5,?6)",
                params![
                    service.id,
                    service.project_id,
                    service.name,
                    position(index)?,
                    json_value(&service.headers)?,
                    json_value(&service.auth)?
                ],
            )
            .map_err(db_error)?;
    }
    for (index, binding) in workspace.bindings.iter().enumerate() {
        connection.execute(
            "INSERT INTO service_environment(id,project_id,service_id,environment_id,base_url,enabled,position)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![binding.id, binding.project_id, binding.service_id, binding.environment_id, binding.base_url, binding.enabled, position(index)?],
        ).map_err(db_error)?;
    }
    for (index, folder) in workspace.folders.iter().enumerate() {
        connection
            .execute(
                "INSERT INTO folder(id,service_id,parent_id,name,position) VALUES (?1,?2,?3,?4,?5)",
                params![
                    folder.id,
                    folder.service_id,
                    folder.parent_id,
                    folder.name,
                    position(index)?
                ],
            )
            .map_err(db_error)?;
    }
    let service_projects: HashMap<_, _> = workspace
        .services
        .iter()
        .map(|service| (service.id.as_str(), service.project_id.as_str()))
        .collect();
    for (index, request) in workspace.requests.iter().enumerate() {
        let project_id = service_projects
            .get(request.service_id.as_str())
            .ok_or_else(|| "接口引用的服务不存在".to_string())?;
        let timeout = i64::try_from(request.timeout_ms)
            .map_err(|_| "接口超时超出 SQLite 支持范围".to_string())?;
        connection.execute(
            "INSERT INTO request(id,project_id,service_id,folder_id,name,method,path,body_type,body,timeout_ms,position,auth,form,environment_configs)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            params![request.id, project_id, request.service_id, request.folder_id, request.name,
                request.method, request.path, request.body_type, request.body, timeout, position(index)?,
                json_value(&request.auth)?, json_value(&request.form)?, json_value(&request.environment_configs)?],
        ).map_err(db_error)?;
        for (kind, pairs) in [("query", &request.query), ("header", &request.headers)] {
            for (pair_index, pair) in pairs.iter().enumerate() {
                connection.execute(
                    "INSERT INTO request_pair(request_id,kind,id,key,value,enabled,position) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                    params![request.id, kind, pair.id, pair.key, pair.value, pair.enabled, position(pair_index)?],
                ).map_err(db_error)?;
            }
        }
    }
    for (index, variable) in workspace.variables.iter().enumerate() {
        let mut owners: [Option<&str>; 5] = [None; 5];
        let owner_index = match variable.scope.as_str() {
            "project" => 0,
            "service" => 1,
            "environment" => 2,
            "binding" => 3,
            "request" => 4,
            _ => return Err("变量 scope 无效".to_string()),
        };
        owners[owner_index] = Some(&variable.owner_id);
        connection.execute(
            "INSERT INTO variable_scope(project_id,kind,owner_id,project_owner_id,service_id,environment_id,binding_id,request_id)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(kind,owner_id) DO NOTHING",
            params![variable.project_id, variable.scope, variable.owner_id, owners[0], owners[1], owners[2], owners[3], owners[4]],
        ).map_err(db_error)?;
        let scope_id: i64 = connection
            .query_row(
                "SELECT id FROM variable_scope WHERE kind=?1 AND owner_id=?2 AND project_id=?3",
                params![variable.scope, variable.owner_id, variable.project_id],
                |r| r.get(0),
            )
            .map_err(db_error)?;
        let plain = (!variable.is_secret).then_some(variable.value.as_str());
        let secret_id = variable.is_secret.then_some(variable.id.as_str());
        connection.execute(
            "INSERT INTO variable(id,project_id,scope_id,name,value,is_secret,secret_id,position) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)",
            params![variable.id, variable.project_id, scope_id, variable.name, plain, variable.is_secret, secret_id, position(index)?],
        ).map_err(db_error)?;
        if variable.is_secret {
            let ciphertext = ciphertexts
                .get(variable.id.as_str())
                .ok_or_else(|| "敏感值未受保护，已停止保存".to_string())?;
            connection
                .execute(
                    "INSERT INTO secret(variable_id,project_id,ciphertext) VALUES (?1,?2,?3)",
                    params![variable.id, variable.project_id, ciphertext],
                )
                .map_err(db_error)?;
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "store/v2_tests.rs"]
mod v2_tests;

#[cfg(test)]
#[path = "store/v3_tests.rs"]
mod v3_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use tempfile::tempdir;

    fn fixture() -> Workspace {
        serde_json::from_value(json!({
            "revision": 0, "activeProjectId": "p1",
            "projects": [
                {"id":"p1","name":"中文项目","activeEnvironmentId":"e1"},
                {"id":"p2","name":"第二项目","activeEnvironmentId":"e2"}
            ],
            "environments": [
                {"id":"e1","projectId":"p1","name":"测试","isProduction":false},
                {"id":"e2","projectId":"p2","name":"生产","isProduction":true}
            ],
            "services": [
                {"id":"s1","projectId":"p1","name":"订单"},
                {"id":"s2","projectId":"p2","name":"订单"}
            ],
            "bindings": [
                {"id":"b1","projectId":"p1","serviceId":"s1","environmentId":"e1",
                 "baseUrl":"https://example.invalid/网关","enabled":true}
            ],
            "folders": [
                {"id":"f2","serviceId":"s1","parentId":"f1","name":"子目录"},
                {"id":"f1","serviceId":"s1","parentId":null,"name":"根目录"}
            ],
            "requests": [
                {"id":"r1","serviceId":"s1","folderId":"f2","name":"查询","method":"POST",
                 "path":"/orders/{{id}}",
                 "query":[
                    {"id":"q1","key":"tag","value":"甲","enabled":true},
                    {"id":"q2","key":"tag","value":"乙","enabled":false}
                 ],
                 "headers":[{"id":"h1","key":"X-Test","value":"值","enabled":true}],
                 "bodyType":"json","body":"{\"id\":\"{{id}}\"}","timeoutMs":30000}
            ],
            "variables": [
                {"id":"v1","projectId":"p1","scope":"project","ownerId":"p1","name":"id","value":"1","isSecret":false},
                {"id":"v2","projectId":"p1","scope":"service","ownerId":"s1","name":"id","value":"","isSecret":false},
                {"id":"v3","projectId":"p1","scope":"environment","ownerId":"e1","name":"id","value":"3","isSecret":false},
                {"id":"v4","projectId":"p1","scope":"binding","ownerId":"b1","name":"id","value":"4","isSecret":false},
                {"id":"v5","projectId":"p1","scope":"request","ownerId":"r1","name":"id","value":"5","isSecret":false}
            ]
        })).unwrap()
    }

    fn value(workspace: &Workspace) -> Value {
        serde_json::to_value(workspace).unwrap()
    }

    fn changed(workspace: &Workspace, edit: impl FnOnce(&mut Value)) -> Workspace {
        let mut data = value(workspace);
        edit(&mut data);
        serde_json::from_value(data).unwrap()
    }

    fn assert_rejected(edit: impl FnOnce(&mut Value)) {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("约束.sqlite")).unwrap();
        let saved = store.save(fixture()).unwrap();
        let invalid = changed(&saved, edit);
        assert!(
            store.save(invalid).is_err(),
            "invalid snapshot was accepted"
        );
        assert_eq!(
            value(&store.load().unwrap()),
            value(&saved),
            "failed save changed data"
        );
    }

    #[test]
    fn empty_database_contains_no_business_seed() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("空库.sqlite")).unwrap();
        assert_eq!(
            value(&store.load().unwrap()),
            json!({
                "revision":0,"activeProjectId":null,"projects":[],"environments":[],
                "services":[],"bindings":[],"folders":[],"requests":[],"variables":[]
            })
        );
    }

    #[test]
    fn structured_round_trip_restart_update_and_delete() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("中文 数据.sqlite");
        let store = Store::open(&path).unwrap();
        let saved = store.save(fixture()).unwrap();
        let mut expected = value(&fixture());
        expected["revision"] = json!(1);
        assert_eq!(value(&saved), expected);
        drop(store);
        let store = Store::open(&path).unwrap();
        assert_eq!(value(&store.load().unwrap()), expected);
        let updated = store
            .save(changed(&saved, |v| {
                v["requests"][0]["folderId"] = Value::Null;
                v["folders"] = json!([]);
                v["requests"][0]["body"] = json!("新内容");
            }))
            .unwrap();
        assert_eq!(value(&updated)["revision"], 2);
        let cleared = store
            .save(changed(&updated, |v| {
                for key in [
                    "projects",
                    "environments",
                    "services",
                    "bindings",
                    "folders",
                    "requests",
                    "variables",
                ] {
                    v[key] = json!([]);
                }
                v["activeProjectId"] = Value::Null;
            }))
            .unwrap();
        assert_eq!(value(&cleared)["revision"], 3);
        let db = Connection::open(path).unwrap();
        for table in [
            "project",
            "environment",
            "service",
            "service_environment",
            "folder",
            "request",
            "request_pair",
            "variable",
            "variable_scope",
            "secret",
        ] {
            let count: i64 = db
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(count, 0, "{table}");
        }
    }

    #[test]
    fn stale_revision_from_second_connection_is_rejected() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("cas.sqlite");
        let a = Store::open(&path).unwrap();
        let b = Store::open(&path).unwrap();
        let stale = b.load().unwrap();
        let saved = a.save(fixture()).unwrap();
        let error = b.save(stale).unwrap_err();
        assert!(error.contains("revision"), "{error}");
        assert_eq!(value(&b.load().unwrap()), value(&saved));
    }

    #[test]
    fn simultaneous_saves_have_exactly_one_winner() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("race.sqlite");
        let a = Store::open(&path).unwrap();
        let b = Store::open(&path).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let other = barrier.clone();
        let first = std::thread::spawn(move || {
            barrier.wait();
            a.save(fixture()).is_ok()
        });
        let second = std::thread::spawn(move || {
            other.wait();
            b.save(fixture()).is_ok()
        });
        assert_ne!(first.join().unwrap(), second.join().unwrap());
        assert_eq!(
            value(&Store::open(&path).unwrap().load().unwrap())["revision"],
            1
        );
    }

    #[test]
    fn cross_project_bindings_and_selections_are_rejected() {
        assert_rejected(|v| v["bindings"][0]["environmentId"] = json!("e2"));
        assert_rejected(|v| v["bindings"][0]["serviceId"] = json!("s2"));
        assert_rejected(|v| v["projects"][0]["activeEnvironmentId"] = json!("e2"));
        assert_rejected(|v| v["activeProjectId"] = json!("missing"));
    }

    #[test]
    fn folders_and_requests_cannot_cross_service_or_have_cycles() {
        assert_rejected(|v| v["folders"][0]["serviceId"] = json!("s2"));
        assert_rejected(|v| v["requests"][0]["serviceId"] = json!("s2"));
        assert_rejected(|v| v["folders"][1]["parentId"] = json!("f2"));
        assert_rejected(|v| v["folders"][0]["parentId"] = json!("f2"));
        assert_rejected(|v| v["folders"][0]["parentId"] = json!("missing"));
    }

    #[test]
    fn duplicate_scoped_names_ids_and_binding_are_rejected() {
        for table in ["environments", "services", "bindings", "variables"] {
            assert_rejected(|v| {
                let mut item = v[table][0].clone();
                item["id"] = json!("new-id");
                v[table].as_array_mut().unwrap().push(item);
            });
        }
        for index in [0, 1] {
            assert_rejected(|v| {
                let mut folder = v["folders"][index].clone();
                folder["id"] = json!("f3");
                v["folders"].as_array_mut().unwrap().push(folder);
            });
        }
        assert_rejected(|v| {
            let project = v["projects"][0].clone();
            v["projects"].as_array_mut().unwrap().push(project);
        });
        assert_rejected(|v| v["projects"][0]["id"] = json!(""));
    }

    #[test]
    fn each_variable_scope_checks_owner_type_and_project() {
        for (index, foreign) in [
            (0, "p2"),
            (1, "s2"),
            (2, "e2"),
            (3, "missing"),
            (4, "missing"),
        ] {
            assert_rejected(|v| v["variables"][index]["ownerId"] = json!(foreign));
            assert_rejected(|v| v["variables"][index]["projectId"] = json!("p2"));
        }
        assert_rejected(|v| v["variables"][0]["scope"] = json!("unknown"));
        assert_rejected(|v| v["variables"][0]["ownerId"] = json!("s1"));
    }

    #[test]
    fn late_write_failure_rolls_back_revision_and_all_tables() {
        assert_rejected(|v| {
            v["projects"][0]["name"] = json!("must roll back");
            v["requests"][0]["query"][1]["id"] = json!("q1");
        });
    }

    #[test]
    fn newer_schema_is_rejected_without_modifying_it() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("future.sqlite");
        drop(Store::open(&path).unwrap());
        let db = Connection::open(&path).unwrap();
        db.execute("INSERT INTO schema_migration(version) VALUES (999)", [])
            .unwrap();
        assert!(Store::open(&path).is_err());
        assert_eq!(
            db.query_row("SELECT max(version) FROM schema_migration", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            999
        );
    }

    #[test]
    fn unrecognized_existing_database_is_not_reinitialized() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("unknown.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(
            "CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES ('keep');",
        )
        .unwrap();
        assert!(Store::open(&path).is_err());
        assert_eq!(
            db.query_row("SELECT value FROM unrelated", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "keep"
        );
        assert_eq!(
            db.query_row(
                "SELECT count(*) FROM sqlite_master WHERE name='schema_migration'",
                [],
                |r| r.get::<_, i64>(0),
            )
            .unwrap(),
            0
        );
    }

    #[test]
    fn revision_and_timeout_overflows_do_not_change_snapshot() {
        assert_rejected(|v| v["revision"] = json!(u64::MAX));
        assert_rejected(|v| v["requests"][0]["timeoutMs"] = json!(u64::MAX));
        assert_rejected(|v| v["requests"][0]["timeoutMs"] = json!(0));
        assert_rejected(|v| v["requests"][0]["bodyType"] = json!("unknown"));
    }

    #[test]
    fn missing_references_and_empty_ids_are_rejected() {
        for table in [
            "projects",
            "environments",
            "services",
            "bindings",
            "folders",
            "requests",
            "variables",
        ] {
            assert_rejected(|v| v[table][0]["id"] = json!(""));
        }
        assert_rejected(|v| v["requests"][0]["headers"][0]["id"] = json!(""));
        assert_rejected(|v| v["requests"][0]["folderId"] = json!("missing"));
        assert_rejected(|v| v["requests"][0]["serviceId"] = json!("missing"));
        assert_rejected(|v| v["environments"][0]["projectId"] = json!("missing"));
        assert_rejected(|v| v["services"][0]["projectId"] = json!("missing"));
        assert_rejected(|v| v["variables"][0]["projectId"] = json!("missing"));
    }

    #[cfg(windows)]
    #[test]
    fn review_cross_project_secret_id_cannot_inherit_old_ciphertext() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("secret-owner.sqlite");
        let store = Store::open(&path).unwrap();
        let saved = store
            .save(changed(&fixture(), |v| {
                v["variables"][0]["isSecret"] = json!(true);
                v["variables"][0]["value"] = json!("project-one-private");
            }))
            .unwrap();
        let moved = changed(&saved, |v| {
            v["variables"][0]["projectId"] = json!("p2");
            v["variables"][0]["ownerId"] = json!("p2");
        });
        assert!(
            store.save(moved.clone()).is_err(),
            "empty value inherited another project's secret"
        );
        assert_eq!(value(&store.load().unwrap()), value(&saved));
        let replacement = store
            .save(changed(&moved, |v| {
                v["variables"][0]["value"] = json!("project-two-reentered");
            }))
            .unwrap();
        assert_eq!(replacement.variables[0].project_id, "p2");
        assert_eq!(
            store.load_for_execution().unwrap().variables[0].value,
            "project-two-reentered"
        );
    }

    fn corrupt_scope(path: &Path) {
        let db = Connection::open(path).unwrap();
        let count: i64 = db
            .query_row("SELECT count(*) FROM variable", [], |r| r.get(0))
            .unwrap();
        db.execute_batch(
            "PRAGMA foreign_keys=OFF;
             DELETE FROM variable_scope WHERE kind='project' AND owner_id='p1';",
        )
        .unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM variable", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            count
        );
    }

    #[test]
    fn review_open_rejects_dangling_scope_without_repairing_database() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("open-corrupt.sqlite");
        Store::open(&path).unwrap().save(fixture()).unwrap();
        corrupt_scope(&path);
        assert!(
            Store::open(&path).is_err(),
            "open accepted a dangling scope"
        );
        let db = Connection::open(path).unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM variable", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            5
        );
    }

    #[test]
    fn review_load_rejects_dangling_scope_instead_of_omitting_variable() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("load-corrupt.sqlite");
        let store = Store::open(&path).unwrap();
        store.save(fixture()).unwrap();
        corrupt_scope(&path);
        assert!(
            store.load().is_err(),
            "load silently omitted an orphan variable"
        );
        assert!(store.load_for_execution().is_err());
    }

    #[test]
    fn review_save_rejects_corrupt_database_before_deleting_or_updating_revision() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("save-corrupt.sqlite");
        let store = Store::open(&path).unwrap();
        let saved = store.save(fixture()).unwrap();
        corrupt_scope(&path);
        let db = Connection::open(&path).unwrap();
        // Even a valid stale UI snapshot must not "repair" a corrupted database.
        assert!(
            store.save(saved).is_err(),
            "save silently rewrote corrupt data"
        );
        assert_eq!(
            db.query_row("SELECT revision FROM workspace_state", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM variable_scope", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            4
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM variable", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            5
        );
    }

    #[test]
    fn review_integrity_rejects_missing_state_check_violation_and_folder_cycle() {
        for damage in [
            "DELETE FROM workspace_state",
            "DELETE FROM project_state WHERE project_id='p1'",
            "PRAGMA ignore_check_constraints=ON; UPDATE request SET body_type='damaged'",
            "DROP TRIGGER folder_no_cycle_update; UPDATE folder SET parent_id='f2' WHERE id='f1'",
        ] {
            let dir = tempdir().unwrap();
            let path = dir.path().join("integrity.sqlite");
            let store = Store::open(&path).unwrap();
            let saved = store.save(fixture()).unwrap();
            let db = Connection::open(&path).unwrap();
            db.execute_batch(damage).unwrap();
            assert!(store.load().is_err(), "load accepted: {damage}");
            assert!(store.save(saved).is_err(), "save accepted: {damage}");
            assert!(Store::open(&path).is_err(), "open accepted: {damage}");
        }
    }

    fn request_input(workspace: &Workspace) -> ExecuteInput {
        ExecuteInput {
            execution_id: "store-request-test".to_string(),
            environment_id: "e1".to_string(),
            request: workspace.requests[0].clone(),
            temporary_variables: Vec::new(),
            production_confirmed: false,
        }
    }

    #[cfg(windows)]
    fn request_secret_fixture() -> Workspace {
        changed(&fixture(), |v| {
            v["services"]
                .as_array_mut()
                .unwrap()
                .push(json!({"id":"s3","projectId":"p1","name":"另一服务"}));
            v["environments"]
                .as_array_mut()
                .unwrap()
                .push(json!({"id":"e3","projectId":"p1","name":"另一环境","isProduction":false}));
            v["bindings"].as_array_mut().unwrap().push(json!({
                "id":"b3","projectId":"p1","serviceId":"s1","environmentId":"e3","baseUrl":"https://other.invalid","enabled":true
            }));
            let mut sibling = v["requests"][0].clone();
            sibling["id"] = json!("r2");
            v["requests"].as_array_mut().unwrap().push(sibling);
            for item in v["variables"].as_array_mut().unwrap() {
                item["isSecret"] = json!(true);
                item["value"] = json!(format!("secret-{}", item["id"].as_str().unwrap()));
            }
            for (id, project, scope, owner, name) in [
                ("foreign", "p2", "project", "p2", "id"),
                ("other-service", "p1", "service", "s3", "id"),
                ("other-env", "p1", "environment", "e3", "id"),
                ("other-binding", "p1", "binding", "b3", "id"),
                ("other-request", "p1", "request", "r2", "id"),
                ("unused", "p1", "request", "r1", "unused"),
            ] {
                v["variables"].as_array_mut().unwrap().push(json!({
                    "id":id,"projectId":project,"scope":scope,"ownerId":owner,"name":name,
                    "isSecret":true,"value":"irrelevant-secret"
                }));
            }
        })
    }

    #[cfg(windows)]
    fn corrupt_other_secrets(path: &Path, keep: &str) {
        let db = Connection::open(path).unwrap();
        db.execute(
            "UPDATE secret SET ciphertext=x'626164' WHERE variable_id<>?1",
            [keep],
        )
        .unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn request_snapshot_only_decrypts_referenced_winner_in_matching_scopes() {
        // Exercise every stored priority, with corrupted lower and unrelated
        // secrets. Array order is deliberately reversed; scope determines rank.
        for highest in 1..=5 {
            let dir = tempdir().unwrap();
            let path = dir.path().join("selected-secret.sqlite");
            let store = Store::open(&path).unwrap();
            let mut workspace = request_secret_fixture();
            workspace.variables.retain(|v| {
                !matches!(v.id.as_str(), "v1" | "v2" | "v3" | "v4" | "v5")
                    || v.id[1..].parse::<usize>().unwrap() <= highest
            });
            workspace.variables.reverse();
            let input = request_input(&workspace);
            store.save(workspace).unwrap();
            let winner = format!("v{highest}");
            corrupt_other_secrets(&path, &winner);
            let snapshot = store
                .load_for_request(&input)
                .expect("unrelated ciphertext must not be decrypted");
            for variable in &snapshot.variables {
                assert_eq!(
                    variable.value,
                    if variable.id == winner {
                        format!("secret-{winner}")
                    } else {
                        String::new()
                    }
                );
                assert!(variable.is_secret);
            }
            // Legacy explicit full-decryption API still retains its old behavior.
            assert!(store.load_for_execution().is_err());
        }
    }

    #[cfg(windows)]
    #[test]
    fn request_snapshot_temporary_and_plain_overrides_do_not_decrypt_lower_secrets() {
        for temporary in [false, true] {
            let dir = tempdir().unwrap();
            let path = dir.path().join("overridden.sqlite");
            let store = Store::open(&path).unwrap();
            let mut workspace = request_secret_fixture();
            if !temporary {
                let winner = workspace
                    .variables
                    .iter_mut()
                    .find(|v| v.id == "v5")
                    .unwrap();
                winner.is_secret = false;
                winner.value = "plain-winner".to_string();
            }
            let mut input = request_input(&workspace);
            if temporary {
                input.temporary_variables.push(Pair {
                    id: "temporary".into(),
                    key: "id".into(),
                    value: "".into(),
                    enabled: true,
                });
            }
            store.save(workspace).unwrap();
            corrupt_other_secrets(&path, "none");
            let snapshot = store.load_for_request(&input).unwrap();
            assert!(snapshot
                .variables
                .iter()
                .filter(|v| v.is_secret)
                .all(|v| v.value.is_empty()));
            if temporary {
                input.temporary_variables[0].enabled = false;
                assert!(store
                    .load_for_request(&input)
                    .unwrap_err()
                    .contains("DPAPI"));
            } else {
                assert_eq!(
                    snapshot
                        .variables
                        .iter()
                        .find(|v| v.id == "v5")
                        .unwrap()
                        .value,
                    "plain-winner"
                );
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn request_snapshot_template_dependencies_are_not_recursive() {
        for source in ["plain", "secret", "temporary"] {
            let dir = tempdir().unwrap();
            let path = dir.path().join("non-recursive.sqlite");
            let store = Store::open(&path).unwrap();
            let mut workspace = request_secret_fixture();
            let winner = workspace
                .variables
                .iter_mut()
                .find(|v| v.id == "v5")
                .unwrap();
            winner.value = "{{unused}}".into();
            winner.is_secret = source != "plain";
            let mut input = request_input(&workspace);
            input.request.path = "/{{ id }}".into();
            if source == "temporary" {
                input.temporary_variables.push(Pair {
                    id: "tmp".into(),
                    key: "id".into(),
                    value: "{{unused}}".into(),
                    enabled: true,
                });
            }
            store.save(workspace).unwrap();
            corrupt_other_secrets(&path, if source == "temporary" { "none" } else { "v5" });
            let snapshot = store.load_for_request(&input).unwrap();
            assert_eq!(
                snapshot
                    .variables
                    .iter()
                    .find(|v| v.id == "unused")
                    .unwrap()
                    .value,
                ""
            );
            assert_eq!(
                snapshot
                    .variables
                    .iter()
                    .find(|v| v.id == "v5")
                    .unwrap()
                    .value,
                if source == "temporary" {
                    ""
                } else {
                    "{{unused}}"
                }
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn request_snapshot_ignores_disabled_pairs_none_body_and_saved_template() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("unused-templates.sqlite");
        let store = Store::open(&path).unwrap();
        let workspace = request_secret_fixture();
        let mut input = request_input(&workspace);
        input.request.path = "/static".into();
        input.request.body_type = "none".into();
        input.request.body = "{{unused}}".into();
        input.request.query = vec![Pair {
            id: "q".into(),
            key: "{{id}}".into(),
            value: "{{unused}}".into(),
            enabled: false,
        }];
        input.request.headers = input.request.query.clone();
        store.save(workspace).unwrap();
        corrupt_other_secrets(&path, "none");
        let snapshot = store.load_for_request(&input).unwrap();
        assert!(snapshot.variables.iter().all(|v| v.value.is_empty()));
    }

    #[cfg(windows)]
    #[test]
    fn request_snapshot_scans_all_executed_template_surfaces_and_decoded_json_strings() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("template-surfaces.sqlite");
        let store = Store::open(&path).unwrap();
        let workspace = request_secret_fixture();
        let mut base = request_input(&workspace);
        base.request.path = "/static".into();
        base.request.body_type = "none".into();
        base.request.query.clear();
        base.request.headers.clear();
        store.save(workspace).unwrap();
        corrupt_other_secrets(&path, "v5");
        let mut cases = Vec::new();
        let mut path_input = base.clone();
        path_input.request.path = "/{{ id }}".into();
        cases.push(path_input);
        for header in [false, true] {
            for key in [false, true] {
                let mut input = base.clone();
                let pair = Pair {
                    id: "pair".into(),
                    key: if key { "{{id}}" } else { "key" }.into(),
                    value: if key { "value" } else { "{{id}}" }.into(),
                    enabled: true,
                };
                if header {
                    input.request.headers.push(pair);
                } else {
                    input.request.query.push(pair);
                }
                cases.push(input);
            }
        }
        for (kind, body) in [
            ("text", "{{id}}"),
            (
                "json",
                r#"{"nested":[{"x":"\u007b\u007b id \u007d\u007d"}]}"#,
            ),
            ("json", r#""{{id}}""#),
        ] {
            let mut input = base.clone();
            input.request.body_type = kind.into();
            input.request.body = body.into();
            cases.push(input);
        }
        for input in cases {
            let snapshot = store.load_for_request(&input).unwrap();
            assert_eq!(
                snapshot
                    .variables
                    .iter()
                    .find(|v| v.id == "v5")
                    .unwrap()
                    .value,
                "secret-v5"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn request_snapshot_rejects_bad_context_and_templates_before_decryption() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("context-check.sqlite");
        let store = Store::open(&path).unwrap();
        let workspace = request_secret_fixture();
        let base = request_input(&workspace);
        store.save(workspace).unwrap();
        corrupt_other_secrets(&path, "none");
        type InputEdit = Box<dyn Fn(&mut ExecuteInput)>;
        let invalid: Vec<InputEdit> = vec![
            Box::new(|i| i.request.id = "missing".into()),
            Box::new(|i| i.request.service_id = "s2".into()),
            Box::new(|i| i.environment_id = "e2".into()),
            Box::new(|i| i.request.folder_id = Some("missing".into())),
            Box::new(|i| i.execution_id.clear()),
            Box::new(|i| i.request.path = "/{{".into()),
            Box::new(|i| i.request.path = "/{{ }}".into()),
            Box::new(|i| i.request.path = "/{{ a{b }}".into()),
            Box::new(|i| i.request.path = "/{{ a\nb }}".into()),
            Box::new(|i| i.request.body = r#"{"{{id}}":"value"}"#.into()),
            Box::new(|i| i.request.body = "{".into()),
        ];
        for edit in invalid {
            let mut input = base.clone();
            edit(&mut input);
            let error = store.load_for_request(&input).unwrap_err();
            assert!(
                !error.contains("DPAPI"),
                "invalid input reached decryption: {error}"
            );
        }
        let db = Connection::open(path).unwrap();
        db.execute("UPDATE service_environment SET enabled=0 WHERE id='b1'", [])
            .unwrap();
        assert!(!store.load_for_request(&base).unwrap_err().contains("DPAPI"));
    }

    #[cfg(windows)]
    #[test]
    fn request_snapshot_matching_broken_secret_fails_but_unreferenced_one_does_not() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("required-secret.sqlite");
        let store = Store::open(&path).unwrap();
        let workspace = request_secret_fixture();
        let input = request_input(&workspace);
        let saved = store.save(workspace).unwrap();
        corrupt_other_secrets(&path, "none");
        let error = store.load_for_request(&input).unwrap_err();
        assert!(error.contains("DPAPI"));
        assert_eq!(value(&store.load().unwrap()), value(&saved));
        corrupt_scope(&path);
        assert!(!store
            .load_for_request(&input)
            .unwrap_err()
            .contains("DPAPI"));
    }

    #[cfg(windows)]
    #[test]
    fn request_snapshot_revision_metadata_and_secret_stay_consistent_during_writes() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("snapshot-race.sqlite");
        let reader = Store::open(&path).unwrap();
        let writer = Store::open(&path).unwrap();
        let mut workspace = fixture();
        workspace.projects[0].name = "revision-1".into();
        workspace.variables[4].is_secret = true;
        workspace.variables[4].value = "secret-revision-1".into();
        let input = request_input(&workspace);
        let saved = reader.save(workspace).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let other = barrier.clone();
        let writing = std::thread::spawn(move || {
            let mut saved = saved;
            other.wait();
            for revision in 2..=25 {
                saved.projects[0].name = format!("revision-{revision}");
                saved.variables[4].value = format!("secret-revision-{revision}");
                saved = writer.save(saved).unwrap();
            }
        });
        barrier.wait();
        for _ in 0..30 {
            let snapshot = reader.load_for_request(&input).unwrap();
            assert_eq!(
                snapshot.projects[0].name,
                format!("revision-{}", snapshot.revision)
            );
            assert_eq!(
                snapshot.variables[4].value,
                format!("secret-revision-{}", snapshot.revision)
            );
        }
        writing.join().unwrap();
        assert_eq!(reader.load_for_request(&input).unwrap().revision, 25);
    }

    #[cfg(windows)]
    #[test]
    fn request_snapshot_active_project_and_temporary_validation_precede_dpapi() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("active-project.sqlite");
        let store = Store::open(&path).unwrap();
        let workspace = request_secret_fixture();
        let mut input = request_input(&workspace);
        store.save(workspace).unwrap();
        corrupt_other_secrets(&path, "none");
        let db = Connection::open(&path).unwrap();
        db.execute("UPDATE workspace_state SET active_project_id='p2'", [])
            .unwrap();
        assert!(!store
            .load_for_request(&input)
            .unwrap_err()
            .contains("DPAPI"));
        db.execute("UPDATE workspace_state SET active_project_id=NULL", [])
            .unwrap();
        assert!(!store
            .load_for_request(&input)
            .unwrap_err()
            .contains("DPAPI"));
        db.execute("UPDATE workspace_state SET active_project_id='p1'", [])
            .unwrap();
        input.temporary_variables = vec![
            Pair {
                id: "a".into(),
                key: "id".into(),
                value: "first".into(),
                enabled: true,
            },
            Pair {
                id: "b".into(),
                key: "id".into(),
                value: "second".into(),
                enabled: true,
            },
        ];
        assert!(store.load_for_request(&input).unwrap_err().contains("重复"));
        input.temporary_variables[1].enabled = false;
        assert!(store.load_for_request(&input).is_ok());
        input.temporary_variables[0].key = " ".into();
        assert!(store
            .load_for_request(&input)
            .unwrap_err()
            .contains("空名称"));
    }

    #[test]
    fn sql_constraints_protect_writers_that_bypass_store() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("direct.sqlite");
        Store::open(&path).unwrap().save(fixture()).unwrap();
        let db = Connection::open(&path).unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        for sql in [
            "UPDATE service_environment SET environment_id='e2' WHERE id='b1'",
            "UPDATE project_state SET environment_id='e2' WHERE project_id='p1'",
            "UPDATE folder SET service_id='s2' WHERE id='f2'",
            "UPDATE folder SET parent_id='f2' WHERE id='f1'",
            "UPDATE request SET service_id='s2' WHERE id='r1'",
            "UPDATE variable_scope SET project_id='p2' WHERE kind='service'",
            "UPDATE variable_scope SET kind='unknown' WHERE kind='service'",
            "UPDATE variable SET value=NULL WHERE id='v1'",
        ] {
            assert!(db.execute_batch(sql).is_err(), "SQL accepted: {sql}");
        }
        assert_eq!(
            db.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            0
        );
    }

    #[cfg(windows)]
    #[test]
    fn secrets_are_encrypted_masked_preserved_updated_and_deleted() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("秘密.sqlite");
        let token = "secret-中文-123456789-private";
        let store = Store::open(&path).unwrap();
        let initial = changed(&fixture(), |v| {
            v["variables"][0]["isSecret"] = json!(true);
            v["variables"][0]["value"] = json!(token);
        });
        let saved = store.save(initial).unwrap();
        assert_eq!(value(&saved)["variables"][0]["value"], "");
        assert_eq!(
            value(&store.load_for_execution().unwrap())["variables"][0]["value"],
            token
        );
        let db = Connection::open(&path).unwrap();
        let first: Vec<u8> = db
            .query_row(
                "SELECT ciphertext FROM secret WHERE variable_id='v1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!first.windows(token.len()).any(|b| b == token.as_bytes()));
        assert!(db
            .query_row("SELECT value FROM variable WHERE id='v1'", [], |r| r
                .get::<_, Option<String>>(0))
            .unwrap()
            .is_none());
        let saved = store.save(saved).unwrap();
        let retained: Vec<u8> = db
            .query_row(
                "SELECT ciphertext FROM secret WHERE variable_id='v1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(first, retained);
        drop(store);
        let store = Store::open(&path).unwrap();
        assert_eq!(
            value(&store.load_for_execution().unwrap())["variables"][0]["value"],
            token
        );
        let updated = store
            .save(changed(&saved, |v| {
                v["variables"][0]["value"] = json!("new-secret")
            }))
            .unwrap();
        assert_eq!(
            value(&store.load_for_execution().unwrap())["variables"][0]["value"],
            "new-secret"
        );
        store
            .save(changed(&updated, |v| {
                v["variables"].as_array_mut().unwrap().remove(0);
            }))
            .unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM secret", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        for suffix in ["", "-wal"] {
            let filename = path.with_file_name(format!("秘密.sqlite{suffix}"));
            if let Ok(bytes) = std::fs::read(filename) {
                assert!(!bytes.windows(token.len()).any(|b| b == token.as_bytes()));
            }
        }
    }

    #[cfg(windows)]
    #[test]
    fn new_empty_secret_and_secret_to_plain_conversion() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("empty-secret.sqlite");
        let store = Store::open(&path).unwrap();
        let masked = store
            .save(changed(&fixture(), |v| {
                v["variables"][0]["isSecret"] = json!(true);
                v["variables"][0]["value"] = json!("");
            }))
            .unwrap();
        assert_eq!(
            value(&store.load_for_execution().unwrap())["variables"][0]["value"],
            ""
        );
        store
            .save(changed(&masked, |v| {
                v["variables"][0]["isSecret"] = json!(false);
                v["variables"][0]["value"] = json!("ordinary");
            }))
            .unwrap();
        assert_eq!(
            value(&store.load().unwrap())["variables"][0]["value"],
            "ordinary"
        );
        let db = Connection::open(path).unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM secret", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[cfg(windows)]
    #[test]
    fn corrupt_secret_does_not_break_masked_load_or_leak_in_error() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("corrupt-secret.sqlite");
        let store = Store::open(&path).unwrap();
        store
            .save(changed(&fixture(), |v| {
                v["variables"][0]["isSecret"] = json!(true)
            }))
            .unwrap();
        let db = Connection::open(&path).unwrap();
        db.execute(
            "UPDATE secret SET ciphertext=x'626164' WHERE variable_id='v1'",
            [],
        )
        .unwrap();
        assert_eq!(value(&store.load().unwrap())["variables"][0]["value"], "");
        let error = store.load_for_execution().unwrap_err();
        assert!(!error.contains("bad"));
        assert!(error.contains("DPAPI"));
    }

    #[cfg(windows)]
    #[test]
    fn failed_save_restores_original_ciphertext_and_revision() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("secret-rollback.sqlite");
        let store = Store::open(&path).unwrap();
        let saved = store
            .save(changed(&fixture(), |v| {
                v["variables"][0]["isSecret"] = json!(true);
                v["variables"][0]["value"] = json!("original-token");
            }))
            .unwrap();
        let invalid = changed(&saved, |v| {
            v["variables"][0]["value"] = json!("replacement-token");
            // A late deferred FK failure, after the replacement secret is stored.
            v["activeProjectId"] = json!("missing");
        });
        let error = store.save(invalid).unwrap_err();
        assert!(!error.contains("token"));
        assert_eq!(value(&store.load().unwrap()), value(&saved));
        assert_eq!(
            value(&store.load_for_execution().unwrap())["variables"][0]["value"],
            "original-token"
        );
    }

    #[cfg(windows)]
    #[test]
    fn deleting_secret_variable_directly_cascades_its_ciphertext() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("secret-cascade.sqlite");
        let store = Store::open(&path).unwrap();
        store
            .save(changed(&fixture(), |v| {
                v["variables"][0]["isSecret"] = json!(true)
            }))
            .unwrap();
        let db = Connection::open(path).unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON; DELETE FROM variable WHERE id='v1';")
            .unwrap();
        assert_eq!(
            db.query_row("SELECT count(*) FROM secret", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| r
                .get::<_, i64>(
                0
            ))
            .unwrap(),
            0
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn unsupported_secret_backend_rolls_back_the_whole_save() {
        let dir = tempdir().unwrap();
        let store = Store::open(&dir.path().join("unsupported.sqlite")).unwrap();
        let saved = store.save(fixture()).unwrap();
        let error = store
            .save(changed(&saved, |v| {
                v["variables"][0]["isSecret"] = json!(true)
            }))
            .unwrap_err();
        assert!(error.contains("DPAPI"));
        assert_eq!(value(&store.load().unwrap()), value(&saved));
    }
}
