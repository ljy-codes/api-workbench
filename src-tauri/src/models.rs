use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub revision: u64,
    pub active_project_id: Option<String>,
    pub projects: Vec<Project>,
    pub environments: Vec<Environment>,
    pub services: Vec<Service>,
    pub bindings: Vec<Binding>,
    pub folders: Vec<Folder>,
    pub requests: Vec<RequestDefinition>,
    pub variables: Vec<Variable>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pair {
    pub id: String,
    pub key: String,
    pub value: String,
    pub enabled: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub active_environment_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub is_production: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Service {
    pub id: String,
    pub project_id: String,
    pub name: String,
    #[serde(default)]
    pub headers: Vec<Pair>,
    #[serde(default)]
    pub auth: Option<AuthConfig>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AuthConfig {
    pub kind: String,
    pub token: String,
    pub username: String,
    pub password: String,
    pub key: String,
    pub value: String,
    pub location: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormField {
    pub id: String,
    pub key: String,
    pub value: String,
    pub enabled: bool,
    pub kind: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub id: String,
    pub project_id: String,
    pub service_id: String,
    pub environment_id: String,
    pub base_url: String,
    pub enabled: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: String,
    pub service_id: String,
    pub parent_id: Option<String>,
    pub name: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestDefinition {
    pub id: String,
    pub service_id: String,
    pub folder_id: Option<String>,
    pub name: String,
    pub method: String,
    pub path: String,
    pub query: Vec<Pair>,
    pub headers: Vec<Pair>,
    pub body_type: String,
    pub body: String,
    pub timeout_ms: u64,
    #[serde(default)]
    pub auth: Option<AuthConfig>,
    #[serde(default)]
    pub form: Vec<FormField>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment_configs: Option<std::collections::BTreeMap<String, RequestConfig>>,
}

/// Complete environment execution configuration. Legacy request fields remain
/// defaults; execution IPC supplies resolved top-level fields, including drafts.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestConfig {
    pub query: Vec<Pair>,
    pub headers: Vec<Pair>,
    pub body_type: String,
    pub body: String,
    pub timeout_ms: u64,
    #[serde(default)]
    pub auth: Option<AuthConfig>,
    #[serde(default)]
    pub form: Vec<FormField>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Variable {
    pub id: String,
    pub project_id: String,
    pub scope: String,
    pub owner_id: String,
    pub name: String,
    pub value: String,
    pub is_secret: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteInput {
    pub execution_id: String,
    pub environment_id: String,
    pub request: RequestDefinition,
    pub temporary_variables: Vec<Pair>,
    pub production_confirmed: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedVariable {
    pub name: String,
    pub value: String,
    pub source: String,
    pub is_secret: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub url: String,
    pub environment_name: String,
    pub service_name: String,
    pub is_production: bool,
    pub resolved_variables: Vec<ResolvedVariable>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseData {
    pub execution_id: String,
    pub status: u16,
    pub status_text: String,
    pub duration_ms: u64,
    pub size_bytes: u64,
    pub headers: Vec<Pair>,
    pub body: String,
    pub truncated: bool,
    pub environment_name: String,
    pub url: String,
}
