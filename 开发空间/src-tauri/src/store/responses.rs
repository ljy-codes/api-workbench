//! Latest-only DPAPI response cache, independent of workspace revision.
//! All operations share Store's mutex; writes additionally take SQLite's
//! IMMEDIATE lock so multiple Store handles cannot race ownership or eviction.
use super::*;
use std::io::{self, Write};

const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const MAX_CACHE_BYTES: i64 = 64 * 1024 * 1024;
const MAX_CIPHERTEXT_BYTES: usize = MAX_RESPONSE_BYTES + 64 * 1024;

/// Bound allocation during serialization, not after allocating an unbounded
/// JSON String. Counts UTF-8 bytes, all metadata and JSON escaping, not sizeBytes.
struct BoundedPayload(Vec<u8>);

impl Write for BoundedPayload {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > MAX_RESPONSE_BYTES.saturating_sub(self.0.len()) {
            return Err(io::Error::other("response limit"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn response_payload(response: &ResponseData) -> Result<String, String> {
    let mut payload = BoundedPayload(Vec::new());
    serde_json::to_writer(&mut payload, response)
        .map_err(|_| "响应缓存序列化大小超过 8 MiB，未保存响应".to_string())?;
    String::from_utf8(payload.0).map_err(|_| "响应缓存编码无效".into())
}

fn owner(
    connection: &Connection,
    request_id: &str,
    environment_id: &str,
) -> Result<String, String> {
    connection
        .query_row(
            "SELECT r.project_id FROM request r
         JOIN service s ON s.id=r.service_id AND s.project_id=r.project_id
         JOIN environment e ON e.project_id=r.project_id
         WHERE r.id=?1 AND e.id=?2",
            params![request_id, environment_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "响应缓存的接口和环境必须存在且属于同一项目".into())
}

pub(super) fn remove_orphans(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM response_cache
         WHERE NOT EXISTS(SELECT 1 FROM request r
             WHERE r.id=response_cache.request_id AND r.project_id=response_cache.project_id)
         OR NOT EXISTS(SELECT 1 FROM environment e
             WHERE e.id=response_cache.environment_id AND e.project_id=response_cache.project_id)",
            [],
        )
        .map_err(db_error)?;
    Ok(())
}

impl Store {
    pub fn load_response(
        &self,
        request_id: &str,
        environment_id: &str,
    ) -> Result<Option<ResponseData>, String> {
        let mut connection = self.lock()?;
        let tx = connection.transaction().map_err(db_error)?;
        // Lazy UI reads include drafts and late completions after deletion.
        // Missing entities have no cache; existing cross-project pairs still
        // pass through the strict ownership check below and are rejected.
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM request WHERE id=?1)
             AND EXISTS(SELECT 1 FROM environment WHERE id=?2)",
                params![request_id, environment_id],
                |r| r.get(0),
            )
            .map_err(db_error)?;
        if !exists {
            tx.commit().map_err(db_error)?;
            return Ok(None);
        }
        let project_id = owner(&tx, request_id, environment_id)?;
        // Bound reads too, even if a third-party writer disabled CHECKs.
        let row: Option<(Option<Vec<u8>>, i64)> = tx.query_row(
            "SELECT CASE WHEN length(ciphertext)<=?4 THEN ciphertext ELSE NULL END,plaintext_size
             FROM response_cache WHERE request_id=?1 AND environment_id=?2 AND project_id=?3",
            params![request_id, environment_id, project_id, MAX_CIPHERTEXT_BYTES as i64],
            |r| Ok((r.get(0)?, r.get(1)?)),
        ).optional().map_err(db_error)?;
        let result = row
            .map(|(ciphertext, size)| -> Result<ResponseData, String> {
                if !(1..=MAX_RESPONSE_BYTES as i64).contains(&size) {
                    return Err("响应缓存大小无效".into());
                }
                let ciphertext = ciphertext.ok_or("响应缓存密文超过大小限制")?;
                let plaintext = secrets::unprotect(&ciphertext)?;
                if plaintext.len() != size as usize {
                    return Err("响应缓存大小校验失败".into());
                }
                serde_json::from_str(&plaintext).map_err(|_| "响应缓存格式无效".into())
            })
            .transpose()?;
        tx.commit().map_err(db_error)?;
        Ok(result)
    }

    pub fn save_response(
        &self,
        request_id: &str,
        environment_id: &str,
        response: &ResponseData,
    ) -> Result<(), String> {
        let plaintext = response_payload(response)?;
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let project_id = owner(&tx, request_id, environment_id)?;
        let ciphertext = secrets::protect(&plaintext)?;
        if ciphertext.len() > MAX_CIPHERTEXT_BYTES {
            return Err("响应缓存密文超过大小限制".into());
        }
        // Persistent logical clock: no wall-clock rollback or same-ms ties;
        // failed saves roll back the clock too. Never touch workspace revision.
        let previous: i64 = tx
            .query_row(
                "SELECT last_order FROM response_cache_state WHERE singleton=1",
                [],
                |r| r.get(0),
            )
            .map_err(db_error)?;
        let order = previous.checked_add(1).ok_or("响应缓存序号已达上限")?;
        tx.execute(
            "UPDATE response_cache_state SET last_order=?1 WHERE singleton=1",
            [order],
        )
        .map_err(db_error)?;
        tx.execute(
            "INSERT INTO response_cache(request_id,environment_id,project_id,ciphertext,plaintext_size,updated_order)
             VALUES (?1,?2,?3,?4,?5,?6)
             ON CONFLICT(request_id,environment_id) DO UPDATE SET
             project_id=excluded.project_id,ciphertext=excluded.ciphertext,
             plaintext_size=excluded.plaintext_size,updated_order=excluded.updated_order",
            params![request_id, environment_id, project_id, ciphertext, plaintext.len() as i64, order],
        ).map_err(db_error)?;
        let mut total: i64 = tx
            .query_row(
                "SELECT coalesce(sum(plaintext_size),0) FROM response_cache",
                [],
                |r| r.get(0),
            )
            .map_err(db_error)?;
        while total > MAX_CACHE_BYTES {
            let (request, environment, size): (String, String, i64) = tx.query_row(
                "SELECT request_id,environment_id,plaintext_size FROM response_cache ORDER BY updated_order LIMIT 1",
                [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            ).map_err(db_error)?;
            tx.execute(
                "DELETE FROM response_cache WHERE request_id=?1 AND environment_id=?2",
                params![request, environment],
            )
            .map_err(db_error)?;
            total -= size;
        }
        tx.commit().map_err(db_error)
    }

    pub fn clear_response(&self, request_id: &str, environment_id: &str) -> Result<(), String> {
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        owner(&tx, request_id, environment_id)?;
        tx.execute(
            "DELETE FROM response_cache WHERE request_id=?1 AND environment_id=?2",
            params![request_id, environment_id],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)
    }

    pub fn clear_responses(&self) -> Result<(), String> {
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        tx.execute("DELETE FROM response_cache", [])
            .map_err(db_error)?;
        tx.commit().map_err(db_error)
    }

    /// Explicit maintenance only. Does not clear requests, drafts or responses.
    /// VACUUM cannot run inside a transaction. Hold the mutex across validation,
    /// checkpoints and VACUUM; SQLite also excludes external concurrent writers.
    pub fn compact_storage(&self) -> Result<(), String> {
        let mut connection = self.lock()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        validate_integrity(&tx)?;
        read_workspace(&tx, false)?;
        remove_orphans(&tx)?;
        tx.commit().map_err(db_error)?;
        checkpoint(&connection)?;
        connection.execute_batch("VACUUM;").map_err(db_error)?;
        checkpoint(&connection)
    }
}

fn checkpoint(connection: &Connection) -> Result<(), String> {
    let busy: i64 = connection
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get(0))
        .map_err(db_error)?;
    if busy != 0 {
        return Err("SQLite 正被其他连接占用，未完成空间回收，请稍后重试".into());
    }
    Ok(())
}
