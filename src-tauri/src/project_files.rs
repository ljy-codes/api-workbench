//! Bounded local project-file I/O. Paths only come from native dialogs.
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
};
const LIMIT: usize = 10 * 1024 * 1024;

fn validate_path(path: &Path) -> Result<(), String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    if !extension.eq_ignore_ascii_case("json") && !extension.eq_ignore_ascii_case("apiworkbench") {
        return Err("项目文件扩展名必须为 .json 或 .apiworkbench".into());
    }
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() => {
            Err("项目文件必须为普通文件，不能是目录或符号链接".into())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("无法访问项目文件".into()),
    }
}

pub fn read_project(path: &Path) -> Result<String, String> {
    validate_path(path)?;
    let file = File::open(path).map_err(|_| "无法打开项目文件")?;
    let mut bytes = Vec::new();
    file.take(LIMIT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "读取项目文件失败")?;
    if bytes.len() > LIMIT {
        return Err("项目文件超过 10 MiB 限制".into());
    }
    let content = String::from_utf8(bytes).map_err(|_| "项目文件不是有效 UTF-8 文本")?;
    Ok(content
        .strip_prefix('\u{feff}')
        .unwrap_or(&content)
        .to_string())
}

pub fn write_project(path: &Path, content: &str) -> Result<(), String> {
    validate_path(path)?;
    if content.len() > LIMIT {
        return Err("项目文件超过 10 MiB 限制".into());
    }
    // Same-directory temporary + sync + rename: a failed write cannot truncate
    // an existing user export. create_new prevents accidental temp overwrite.
    let suffix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "系统时间无效")?
        .as_nanos();
    let temporary =
        path.with_extension(format!("apiworkbench-{}-{suffix}.tmp", std::process::id()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| "无法创建项目临时文件")?;
    let result = (|| {
        file.write_all(content.as_bytes())
            .map_err(|_| "写入项目文件失败")?;
        file.sync_all().map_err(|_| "刷新项目文件失败")?;
        drop(file);
        fs::rename(&temporary, path).map_err(|_| "替换项目文件失败，请检查文件占用和权限")?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
    };
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "api-workbench-io-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                COUNTER.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn roundtrip_unicode_and_replace_existing_file() {
        let temp = Temp::new();
        let path = temp.0.join("中文项目.apiworkbench");
        write_project(&path, "{\"项目\":\"测试\"}").unwrap();
        assert_eq!(read_project(&path).unwrap(), "{\"项目\":\"测试\"}");
        write_project(&path, "{\"项目\":\"更新\"}").unwrap();
        assert_eq!(read_project(&path).unwrap(), "{\"项目\":\"更新\"}");
        assert_eq!(fs::read_dir(&temp.0).unwrap().count(), 1);
    }
    #[test]
    fn reject_overlimit_write_without_changing_existing_file() {
        let temp = Temp::new();
        let path = temp.0.join("project.json");
        fs::write(&path, "original").unwrap();
        assert!(write_project(&path, &"x".repeat(10 * 1024 * 1024 + 1)).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "original");
    }
    #[test]
    fn reject_overlimit_or_non_utf8_read_and_strip_bom() {
        let temp = Temp::new();
        let path = temp.0.join("project.json");
        fs::write(&path, vec![b'a'; 10 * 1024 * 1024 + 1]).unwrap();
        assert!(read_project(&path).is_err());
        fs::write(&path, [0xff]).unwrap();
        assert!(read_project(&path).is_err());
        fs::write(&path, "\u{feff}{}").unwrap();
        assert_eq!(read_project(&path).unwrap(), "{}");
    }
    #[test]
    fn reject_non_project_extensions_and_directories() {
        let temp = Temp::new();
        let path = temp.0.join("app.db");
        fs::write(&path, "private").unwrap();
        assert!(read_project(&path).is_err());
        assert!(write_project(&path, "overwrite").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "private");
        let dir = temp.0.join("folder.json");
        fs::create_dir(&dir).unwrap();
        assert!(read_project(&dir).is_err());
        assert!(write_project(&dir, "{}").is_err());
    }
}
