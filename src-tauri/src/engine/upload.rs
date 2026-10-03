//! File I/O occurs only after execution authorization, inside the request's
//! cancellable deadline. Transmit only a sanitized basename, never directories.
use crate::models::FormField;
use reqwest::multipart::{Form, Part};
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::Read,
    path::{Component, Path, PathBuf},
};
use tokio_util::sync::CancellationToken;

const FILE_LIMIT: usize = 10 * 1024 * 1024;
const TOTAL_LIMIT: usize = 20 * 1024 * 1024;
const LIMIT_ERROR: &str = "上传文件超限：单文件最大 10 MiB，总文件内容最大 20 MiB";

fn is_link(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Includes junctions and other reparse-point indirections.
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

fn open_regular(value: &str) -> Result<File, String> {
    let path = Path::new(value);
    if !path.is_absolute() || value.chars().any(char::is_control) {
        return Err("上传文件必须为明确选择的绝对路径".into());
    }
    let mut checked = PathBuf::new();
    for component in path.components() {
        if matches!(component, Component::ParentDir) {
            return Err("上传路径不能包含父目录跳转".into());
        }
        checked.push(component);
        // A bare Windows prefix ("C:") is not an absolute directory yet.
        if matches!(component, Component::Prefix(_)) {
            continue;
        }
        let metadata = fs::symlink_metadata(&checked).map_err(|_| "上传文件路径不可访问")?;
        if is_link(&metadata) {
            return Err("上传文件路径不允许符号链接或重解析点".into());
        }
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| "上传文件不可访问")?;
    if !metadata.is_file() || is_link(&metadata) {
        return Err("只能上传普通文件，不允许目录或符号链接".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Open the final reparse point itself, rather than following it. Deny
        // write/delete sharing while the bounded snapshot is being read.
        options.custom_flags(0x0020_0000).share_mode(1);
    }
    let file = options.open(path).map_err(|_| "上传文件打开失败")?;
    let actual = file.metadata().map_err(|_| "上传文件校验失败")?;
    if !actual.is_file() || is_link(&actual) {
        return Err("只能上传普通文件，不允许目录或符号链接".into());
    }
    Ok(file)
}

/// Metadata is only an early rejection, NEVER the read bound. Read at most
/// limit + 1 actual bytes to detect growth, including files with stale sizes.
pub(super) fn read_bounded(
    reader: &mut impl Read,
    limit: usize,
    cancel: &CancellationToken,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 64 * 1024];
    loop {
        if cancel.is_cancelled() {
            return Err("请求已取消".into());
        }
        let count = chunk.len().min(limit + 1 - bytes.len());
        let received = match reader.read(&mut chunk[..count]) {
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err("上传文件读取失败".into()),
        };
        if received == 0 {
            return Ok(bytes);
        }
        bytes.extend_from_slice(&chunk[..received]);
        if bytes.len() > limit {
            return Err(LIMIT_ERROR.into());
        }
    }
}

pub(super) fn filename(index: usize) -> String {
    format!("upload-{}.bin", index + 1)
}

fn upload_filename(value: &str) -> Result<String, String> {
    let name = Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or("上传文件名称无效")?;
    if name.chars().any(char::is_control) {
        return Err("上传文件名称禁止控制字符或 CR/LF 注入".into());
    }
    // Retain the extension for APIs that select import/processing by filename.
    // Quotes and separators have no useful meaning in a transmitted basename.
    Ok(name.replace(['"', '\\', '/'], "_"))
}

pub(super) async fn form(fields: Vec<FormField>) -> Result<Form, String> {
    let cancel = CancellationToken::new();
    // Dropping transport on timeout/cancellation signals even a still-running
    // blocking reader. Its data never reaches transport after that drop.
    let _guard = cancel.clone().drop_guard();
    tokio::task::spawn_blocking(move || {
        let mut form = Form::new();
        let mut total = 0;
        for field in fields {
            if cancel.is_cancelled() {
                return Err("请求已取消".into());
            }
            if field.kind == "text" {
                form = form.text(field.key, field.value);
                continue;
            }
            let filename = upload_filename(&field.value)?;
            let mut file = open_regular(&field.value)?;
            let remaining = FILE_LIMIT.min(TOTAL_LIMIT - total);
            if file.metadata().map_err(|_| "上传文件校验失败")?.len() > remaining as u64 {
                return Err(LIMIT_ERROR.into());
            }
            let bytes = read_bounded(&mut file, remaining, &cancel)?;
            total += bytes.len();
            let part = Part::bytes(bytes)
                .file_name(filename)
                .mime_str("application/octet-stream")
                .map_err(|_| "上传文件类型构建失败")?;
            form = form.part(field.key, part);
        }
        Ok(form)
    })
    .await
    .map_err(|_| "上传文件处理失败")?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn actual_reader_is_bounded_even_without_metadata() {
        struct Endless {
            read: usize,
        }
        impl Read for Endless {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                buf.fill(b'x');
                self.read += buf.len();
                Ok(buf.len())
            }
        }
        let mut reader = Endless { read: 0 };
        assert!(read_bounded(&mut reader, 100, &CancellationToken::new()).is_err());
        assert_eq!(reader.read, 101);
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(read_bounded(&mut reader, 100, &cancel)
            .unwrap_err()
            .contains("取消"));
        assert_eq!(reader.read, 101);
    }
}
