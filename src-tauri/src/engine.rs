//! Native request engine. Only decrypted execution snapshots belong here.
//!
//! Preparation never persists or logs expanded values. Preview and the response
//! URL use a separate redacted rendering; only transport receives the real URL.

use crate::models::{ExecuteInput, Preview, ResponseData, Workspace};
use tokio_util::sync::CancellationToken;

mod auth;
mod curl;
mod prepare;
mod transport;
mod upload;
mod url_builder;
mod variables;

pub fn preview(workspace: &Workspace, input: &ExecuteInput) -> Result<Preview, String> {
    Ok(prepare::prepare(workspace, input, prepare::Mode::Preview)?.preview)
}

pub fn export_curl(workspace: &Workspace, input: &ExecuteInput) -> Result<String, String> {
    curl::export(workspace, input)
}

pub async fn execute(
    workspace: &Workspace,
    input: ExecuteInput,
    cancel: CancellationToken,
) -> Result<ResponseData, String> {
    let started = tokio::time::Instant::now();
    if cancel.is_cancelled() {
        return Err("请求已取消".into());
    }
    let prepared = prepare::prepare(workspace, &input, prepare::Mode::Execute)?;
    if prepared.preview.is_production && !input.production_confirmed {
        return Err("生产环境请求必须先明确确认".into());
    }
    // Preparation, connection, TLS, response headers and every body chunk share
    // one deadline. Dropping the losing future also drops the HTTP body/socket.
    let deadline = started
        .checked_add(prepared.timeout)
        .ok_or("请求超时配置超出范围")?;
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("请求已取消".into()),
        result = tokio::time::timeout_at(
            deadline,
            transport::send(prepared, input.execution_id, started),
        ) => result.map_err(|_| "请求整体超时".to_string())?,
    }
}

#[cfg(test)]
mod tests;
