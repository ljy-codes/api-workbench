//! Native request engine. Only decrypted execution snapshots belong here.
//!
//! Preparation never persists or logs expanded values. Preview and the response
//! URL use a separate redacted rendering; only transport receives the real URL.

use crate::models::{
    DetailedExecutionResult, ExecuteInput, Preview, RequestDiagnostics, RequestOutcome,
    ResponseData, Workspace,
};
use tokio::time::Instant;
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
    let mut timings = ExecutionTimings::new();
    match execute_measured(workspace, input, cancel, &mut timings).await {
        Ok(response) => Ok(with_diagnostics(
            response,
            timings.finish(RequestOutcome::Response),
        )),
        Err(error) => Err(error.message),
    }
}

pub async fn execute_detailed(
    workspace: &Workspace,
    input: ExecuteInput,
    cancel: CancellationToken,
) -> DetailedExecutionResult {
    execute_detailed_with_timings(workspace, input, cancel, ExecutionTimings::new()).await
}

pub(crate) async fn execute_detailed_with_timings(
    workspace: &Workspace,
    input: ExecuteInput,
    cancel: CancellationToken,
    mut timings: ExecutionTimings,
) -> DetailedExecutionResult {
    let result = execute_measured(workspace, input, cancel, &mut timings).await;
    timings.into_detailed(result)
}

pub(crate) struct ExecutionFailure {
    outcome: RequestOutcome,
    message: String,
    safe_message: &'static str,
}

impl ExecutionFailure {
    pub(crate) fn new(outcome: RequestOutcome, message: &'static str) -> Self {
        Self {
            outcome,
            message: message.into(),
            safe_message: message,
        }
    }

    fn validation(message: String) -> Self {
        Self {
            outcome: RequestOutcome::Validation,
            message,
            safe_message: "请求配置校验失败，请检查当前项目、环境、变量及生产确认",
        }
    }

    pub(crate) fn cancelled() -> Self {
        Self::new(RequestOutcome::Cancelled, "请求已取消")
    }

    pub(crate) fn timeout() -> Self {
        Self::new(RequestOutcome::Timeout, "请求整体超时")
    }
}

enum Phase {
    Preparation(Instant),
    Headers(Instant),
    Download(Instant),
}

/// Owned outside the cancellable future: dropping a stalled send/body read
/// preserves every completed chunk and the elapsed part of its current phase.
pub(crate) struct ExecutionTimings {
    started: Instant,
    phase: Option<Phase>,
    diagnostics: RequestDiagnostics,
}

impl ExecutionTimings {
    pub(crate) fn new() -> Self {
        Self {
            started: Instant::now(),
            phase: None,
            diagnostics: RequestDiagnostics {
                outcome: RequestOutcome::Validation,
                total_ms: 0,
                preparation_ms: None,
                headers_ms: None,
                download_ms: None,
                remote_address: None,
                http_version: None,
                received_bytes: None,
            },
        }
    }

    pub(crate) fn start_preparation(&mut self) {
        if self.phase.is_none() {
            self.phase = Some(Phase::Preparation(Instant::now()));
        }
    }

    fn finish_phase(&mut self) {
        match self.phase.take() {
            Some(Phase::Preparation(started)) => {
                self.diagnostics.preparation_ms = Some(elapsed_ms(started))
            }
            Some(Phase::Headers(started)) => {
                self.diagnostics.headers_ms = Some(elapsed_ms(started))
            }
            Some(Phase::Download(started)) => {
                self.diagnostics.download_ms = Some(elapsed_ms(started))
            }
            None => {}
        }
    }

    fn start_headers(&mut self) {
        self.finish_phase();
        self.phase = Some(Phase::Headers(Instant::now()));
    }

    fn start_download(&mut self, response: &reqwest::Response) {
        self.finish_phase();
        self.phase = Some(Phase::Download(Instant::now()));
        self.diagnostics.remote_address = response.remote_addr().map(|address| address.to_string());
        self.diagnostics.http_version = Some(format!("{:?}", response.version()));
        self.diagnostics.received_bytes = Some(0);
    }

    pub(crate) fn deadline(&self, input: &ExecuteInput) -> Result<Instant, ExecutionFailure> {
        if !(1..=300_000).contains(&input.request.timeout_ms) {
            return Err(ExecutionFailure::new(
                RequestOutcome::Validation,
                "请求整体超时必须为 1～300000 毫秒",
            ));
        }
        self.started
            .checked_add(std::time::Duration::from_millis(input.request.timeout_ms))
            .ok_or_else(|| {
                ExecutionFailure::new(RequestOutcome::Validation, "请求超时配置超出范围")
            })
    }

    fn finish(mut self, outcome: RequestOutcome) -> RequestDiagnostics {
        self.finish_phase();
        self.diagnostics.outcome = outcome;
        self.diagnostics.total_ms = elapsed_ms(self.started);
        self.diagnostics
    }

    pub(crate) fn into_detailed(
        self,
        result: Result<ResponseData, ExecutionFailure>,
    ) -> DetailedExecutionResult {
        match result {
            Ok(response) => {
                let diagnostics = self.finish(RequestOutcome::Response);
                DetailedExecutionResult {
                    response: Some(with_diagnostics(response, diagnostics.clone())),
                    error: None,
                    diagnostics,
                }
            }
            Err(error) => DetailedExecutionResult {
                response: None,
                error: Some(error.safe_message.into()),
                diagnostics: self.finish(error.outcome),
            },
        }
    }
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u64::MAX as u128) as u64
}

fn with_diagnostics(mut response: ResponseData, diagnostics: RequestDiagnostics) -> ResponseData {
    response.duration_ms = diagnostics.total_ms;
    response.diagnostics = Some(diagnostics);
    response
}

async fn execute_measured(
    workspace: &Workspace,
    input: ExecuteInput,
    cancel: CancellationToken,
    timings: &mut ExecutionTimings,
) -> Result<ResponseData, ExecutionFailure> {
    if cancel.is_cancelled() {
        return Err(ExecutionFailure::cancelled());
    }
    timings.start_preparation();
    let prepared = prepare::prepare(workspace, &input, prepare::Mode::Execute)
        .map_err(ExecutionFailure::validation)?;
    if prepared.preview.is_production && !input.production_confirmed {
        return Err(ExecutionFailure::validation(
            "生产环境请求必须先明确确认".into(),
        ));
    }
    // Preparation, connection, TLS, response headers and every body chunk share
    // one deadline. Dropping the losing future also drops the HTTP body/socket.
    let deadline = timings.deadline(&input)?;
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(ExecutionFailure::cancelled()),
        result = tokio::time::timeout_at(
            deadline,
            transport::send(prepared, input.execution_id, timings),
        ) => result.unwrap_or_else(|_| Err(ExecutionFailure::timeout())),
    }
}

#[cfg(test)]
mod tests;
