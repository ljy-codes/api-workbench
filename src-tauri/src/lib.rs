#[cfg(test)]
mod command_tests;
pub mod engine;
mod executions;
pub mod models;
mod project_files;
mod report_files;
mod secrets;
pub mod store;

use executions::Executions;
use models::{DetailedExecutionResult, ExecuteInput, Preview, RequestOutcome, ResponseData, Workspace};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

struct AppState {
    store: Arc<store::Store>,
    executions: Executions,
    data_dir: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    data_dir: String,
    version: &'static str,
    portable: bool,
}

#[tauri::command]
async fn load_workspace(state: State<'_, AppState>) -> Result<Workspace, String> {
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || store.load())
        .await
        .map_err(|_| "读取本地配置任务失败")?
}

#[tauri::command]
async fn save_workspace(
    state: State<'_, AppState>,
    workspace: Workspace,
) -> Result<Workspace, String> {
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || store.save(workspace))
        .await
        .map_err(|_| "保存本地配置任务失败")?
}

#[tauri::command]
async fn load_response(
    state: State<'_, AppState>,
    request_id: String,
    environment_id: String,
) -> Result<Option<ResponseData>, String> {
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || store.load_response(&request_id, &environment_id))
        .await
        .map_err(|_| "读取响应缓存任务失败")?
}

#[tauri::command]
async fn save_response(
    state: State<'_, AppState>,
    request_id: String,
    environment_id: String,
    response: ResponseData,
) -> Result<(), String> {
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || {
        store.save_response(&request_id, &environment_id, &response)
    })
    .await
    .map_err(|_| "保存响应缓存任务失败")?
}

#[tauri::command]
async fn clear_response(
    state: State<'_, AppState>,
    request_id: String,
    environment_id: String,
) -> Result<(), String> {
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || store.clear_response(&request_id, &environment_id))
        .await
        .map_err(|_| "清除响应缓存任务失败")?
}

#[tauri::command]
async fn clear_responses(state: State<'_, AppState>) -> Result<(), String> {
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || store.clear_responses())
        .await
        .map_err(|_| "清除全部响应缓存任务失败")?
}

#[tauri::command]
async fn compact_storage(state: State<'_, AppState>) -> Result<(), String> {
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || store.compact_storage())
        .await
        .map_err(|_| "回收本地存储空间任务失败")?
}

#[tauri::command]
async fn preview_request(
    state: State<'_, AppState>,
    input: ExecuteInput,
) -> Result<Preview, String> {
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || {
        // Preview never needs to decrypt persisted secrets.
        engine::preview(&store.load()?, &input)
    })
    .await
    .map_err(|_| "请求预览任务失败")?
}

#[tauri::command]
async fn send_request(
    state: State<'_, AppState>,
    input: ExecuteInput,
) -> Result<ResponseData, String> {
    let running = state.executions.start(&input.execution_id)?;
    let store = state.store.clone();
    let snapshot_input = input.clone();
    let snapshot = tokio::task::spawn_blocking(move || store.load_for_request(&snapshot_input))
        .await
        .map_err(|_| "加载执行配置失败")??;
    engine::execute(&snapshot, input, running.token.clone()).await
}

#[tauri::command(async)]
fn send_request_detailed(
    state: State<'_, AppState>,
    input: ExecuteInput,
) -> impl std::future::Future<Output = DetailedExecutionResult> + Send + 'static {
    send_request_detailed_inner(state.store.clone(), state.executions.clone(), input)
}

async fn send_request_detailed_inner(
    store: Arc<store::Store>,
    executions: Executions,
    input: ExecuteInput,
) -> DetailedExecutionResult {
    let mut timings = engine::ExecutionTimings::new();
    timings.start_preparation();
    let deadline = match timings.deadline(&input) {
        Ok(deadline) => deadline,
        Err(error) => return timings.into_detailed(Err(error)),
    };
    let running = match executions.start(&input.execution_id) {
        Ok(running) => running,
        Err(error) => {
            let failure = if error == "执行管理器不可用" {
                engine::ExecutionFailure::new(RequestOutcome::Transport, "执行管理器不可用")
            } else {
                engine::ExecutionFailure::new(
                    RequestOutcome::Validation,
                    "无法注册执行，请检查执行 ID、重复请求或并发数量",
                )
            };
            return timings.into_detailed(Err(failure));
        }
    };
    let snapshot_input = input.clone();
    // A queued/blocking snapshot can outlive cancellation, but it is read-only
    // and never sends HTTP. The losing future cannot proceed to transport.
    let snapshot = tokio::select! {
        biased;
        _ = running.token.cancelled() => Err(engine::ExecutionFailure::cancelled()),
        result = tokio::time::timeout_at(deadline, tokio::task::spawn_blocking(move || {
            store.load_for_request(&snapshot_input)
        })) => match result {
            Err(_) => Err(engine::ExecutionFailure::timeout()),
            Ok(Ok(Ok(snapshot))) => Ok(snapshot),
            _ => Err(engine::ExecutionFailure::new(
                RequestOutcome::Transport, "加载执行配置失败，请检查本地配置或存储状态",
            )),
        },
    };
    match snapshot {
        Ok(snapshot) => engine::execute_detailed_with_timings(
            &snapshot, input, running.token.clone(), timings,
        ).await,
        Err(error) => timings.into_detailed(Err(error)),
    }
}

#[tauri::command]
fn cancel_request(state: State<'_, AppState>, execution_id: String) -> Result<(), String> {
    state.executions.cancel(&execution_id)
}

#[tauri::command]
fn app_info(state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        data_dir: state.data_dir.to_string_lossy().into_owned(),
        version: env!("CARGO_PKG_VERSION"),
        portable: cfg!(feature = "portable"),
    }
}

#[tauri::command]
async fn pick_upload_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("选择要上传的本地文件")
            .blocking_pick_file()
            .map(|selected| {
                selected
                    .into_path()
                    .map(|path| path.to_string_lossy().into_owned())
                    .map_err(|_| "仅支持本机文件路径".to_string())
            })
            .transpose()
    })
    .await
    .map_err(|_| "打开文件选择器失败")?
}

#[tauri::command]
async fn read_project_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let Some(selected) = app
            .dialog()
            .file()
            .set_title("导入本地项目")
            .add_filter("接口配置文件", &["json", "yaml", "yml", "yaak", "apiworkbench"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = selected.into_path().map_err(|_| "仅支持本机文件路径")?;
        project_files::read_project(&path).map(Some)
    })
    .await
    .map_err(|_| "读取项目文件任务失败")?
}

#[tauri::command]
async fn write_project_file(
    app: tauri::AppHandle,
    content: String,
) -> Result<Option<String>, String> {
    if content.len() > 10 * 1024 * 1024 {
        return Err("项目文件超过 10 MiB 限制".into());
    }
    tokio::task::spawn_blocking(move || {
        let Some(selected) = app
            .dialog()
            .file()
            .set_title("导出本地项目")
            .add_filter("JSON 文件", &["json"])
            .set_file_name("envdock-export.json")
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let path = selected.into_path().map_err(|_| "仅支持本机文件路径")?;
        project_files::write_project(&path, &content)?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|_| "保存项目文件任务失败")?
}

#[tauri::command]
async fn write_investigation_report(
    app: tauri::AppHandle,
    content: String,
) -> Result<Option<String>, String> {
    report_files::validate_content(&content)?;
    tokio::task::spawn_blocking(move || {
        let selected = app
            .dialog()
            .file()
            .set_title("保存请求排查报告")
            .add_filter("HTML 报告", &["html"])
            .set_file_name("envdock-investigation.html")
            .blocking_save_file()
            .map(|selected| selected.into_path().map_err(|_| "保存排查报告失败，请检查文件路径、占用和权限"))
            .transpose()?;
        report_files::write_selected(selected, &content)
    })
    .await
    .map_err(|_| "保存排查报告失败，请检查文件路径、占用和权限")?
}

#[tauri::command]
async fn export_curl(state: State<'_, AppState>, input: ExecuteInput) -> Result<String, String> {
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || engine::export_curl(&store.load()?, &input))
        .await
        .map_err(|_| "导出 cURL 任务失败")?
}

#[tauri::command]
async fn backup_workspace(state: State<'_, AppState>) -> Result<String, String> {
    let store = state.store.clone();
    tokio::task::spawn_blocking(move || {
        store
            .backup()
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|_| "备份工作区任务失败")?
}

fn data_directory(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if cfg!(feature = "portable") {
        let exe = std::env::current_exe()?;
        Ok(exe
            .parent()
            .ok_or("无法确定程序目录")?
            .join("ApiWorkbenchData"))
    } else if cfg!(target_os = "macos") {
        Ok(app.path().app_data_dir()?)
    } else {
        let local = std::env::var_os("LOCALAPPDATA").ok_or("无法确定本地数据目录 LOCALAPPDATA")?;
        Ok(PathBuf::from(local).join("ApiWorkbench"))
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let data_dir = data_directory(app)?;
            std::fs::create_dir_all(&data_dir)?;
            let store =
                store::Store::open(&data_dir.join("app.db")).map_err(std::io::Error::other)?;
            app.manage(AppState {
                store: Arc::new(store),
                executions: Executions::default(),
                data_dir,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_workspace,
            save_workspace,
            load_response,
            save_response,
            clear_response,
            clear_responses,
            compact_storage,
            preview_request,
            send_request,
            send_request_detailed,
            cancel_request,
            app_info,
            pick_upload_file,
            read_project_file,
            write_project_file,
            write_investigation_report,
            export_curl,
            backup_workspace
        ])
        .run(tauri::generate_context!())
        .expect("EnvDock 启动失败：请检查数据目录权限与系统 WebView 运行环境");
}
