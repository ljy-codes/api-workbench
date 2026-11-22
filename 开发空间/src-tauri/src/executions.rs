use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio_util::sync::CancellationToken;

#[derive(Default, Clone)]
pub struct Executions(Arc<Mutex<HashMap<String, CancellationToken>>>);

impl Executions {
    pub fn start(&self, id: &str) -> Result<ExecutionGuard, String> {
        if id.is_empty() || id.len() > 200 {
            return Err("执行 ID 无效".into());
        }
        let mut active = self.0.lock().map_err(|_| "执行管理器不可用")?;
        if active.contains_key(id) {
            return Err("该请求正在执行，请勿重复发送".into());
        }
        if active.len() >= 64 {
            return Err("同时执行的请求过多，请先取消部分请求".into());
        }
        let token = CancellationToken::new();
        active.insert(id.into(), token.clone());
        Ok(ExecutionGuard {
            token,
            id: id.into(),
            registry: self.clone(),
        })
    }
    pub fn cancel(&self, id: &str) -> Result<(), String> {
        let active = self.0.lock().map_err(|_| "执行管理器不可用")?;
        if let Some(token) = active.get(id) {
            token.cancel();
        }
        Ok(())
    }
}

pub struct ExecutionGuard {
    pub token: CancellationToken,
    id: String,
    registry: Executions,
}

impl Drop for ExecutionGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.registry.0.lock() {
            active.remove(&self.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn execution_ids_cannot_overlap_and_cleanup_on_drop() {
        let registry = Executions::default();
        let running = registry.start("first").unwrap();
        assert!(registry.start("first").is_err());
        drop(running);
        assert!(registry.start("first").is_ok());
    }

    #[test]
    fn cancel_only_targets_its_execution() {
        let registry = Executions::default();
        let first = registry.start("first").unwrap();
        let second = registry.start("second").unwrap();
        registry.cancel("first").unwrap();
        assert!(first.token.is_cancelled());
        assert!(!second.token.is_cancelled());
    }

    #[test]
    fn reject_empty_and_excessively_long_ids() {
        let registry = Executions::default();
        assert!(registry.start("").is_err());
        assert!(registry.start(&"x".repeat(201)).is_err());
    }

    #[test]
    fn cancel_unknown_is_idempotent() {
        assert!(Executions::default().cancel("gone").is_ok());
    }
}
