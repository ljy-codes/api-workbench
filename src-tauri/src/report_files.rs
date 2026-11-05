//! HTML reports have their own dialog-only save boundary; project formats stay
//! unchanged. Never open/truncate the destination before a complete synced save.
use std::{
    fs::{self, Metadata, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

const LIMIT: usize = 10 * 1024 * 1024;
const SAVE_ERROR: &str = "保存排查报告失败，请检查文件路径、占用和权限";
static COUNTER: AtomicU64 = AtomicU64::new(0);

pub(crate) fn validate_content(content: &str) -> Result<(), String> {
    if content.len() > LIMIT {
        return Err("排查报告超过 10 MiB 限制".into());
    }
    Ok(())
}

fn is_link(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

fn validate_path(path: &Path) -> Result<(), String> {
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("html"))
    {
        return Err("排查报告扩展名必须为 .html".into());
    }
    if !path.is_absolute() {
        return Err(SAVE_ERROR.into());
    }
    let mut checked = PathBuf::new();
    for component in path.components() {
        if matches!(component, Component::ParentDir | Component::CurDir) {
            return Err(SAVE_ERROR.into());
        }
        checked.push(component);
        if matches!(component, Component::Prefix(_)) {
            continue;
        }
        let metadata = match fs::symlink_metadata(&checked) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && checked == path => {
                return Ok(());
            }
            Err(_) => return Err(SAVE_ERROR.into()),
        };
        if is_link(&metadata)
            || if checked == path {
                !metadata.is_file()
            } else {
                !metadata.is_dir()
            }
        {
            return Err(SAVE_ERROR.into());
        }
    }
    Ok(())
}

pub(crate) fn write_selected(
    selected: Option<PathBuf>,
    content: &str,
) -> Result<Option<String>, String> {
    let Some(path) = selected else {
        return Ok(None);
    };
    validate_content(content)?;
    validate_path(&path)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| SAVE_ERROR)?
        .as_nanos();
    let temporary = path.with_file_name(format!(
        ".envdock-report-{}-{stamp}-{}.tmp",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed),
    ));
    // create_new never follows a pre-existing temporary-file link.
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| SAVE_ERROR)?;
    let result = (|| -> Result<(), String> {
        file.write_all(content.as_bytes()).map_err(|_| SAVE_ERROR)?;
        file.sync_all().map_err(|_| SAVE_ERROR)?;
        drop(file);
        // Recheck after writing as well. Rename replaces the directory entry
        // atomically; it never writes through a final-component symlink.
        validate_path(&path)?;
        fs::rename(&temporary, &path).map_err(|_| SAVE_ERROR)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn report_save_roundtrips_unicode_and_atomically_replaces_an_existing_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("排查报告.html");
        assert_eq!(
            write_selected(Some(path.clone()), "<!doctype html><p>中文</p>").unwrap(),
            Some(path.to_string_lossy().into_owned())
        );
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "<!doctype html><p>中文</p>"
        );
        write_selected(Some(path.clone()), "<p>更新</p>").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "<p>更新</p>");
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[test]
    fn cancelled_report_save_returns_none_without_creating_a_file() {
        assert_eq!(write_selected(None, "<p>cancelled</p>").unwrap(), None);
    }

    #[test]
    fn report_limit_is_utf8_bytes_and_rejection_preserves_the_old_file() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("report.html");
        fs::write(&path, "old-report").unwrap();
        let exactly_limit = "x".repeat(10 * 1024 * 1024);
        write_selected(Some(path.clone()), &exactly_limit).unwrap();
        for content in [format!("{exactly_limit}x"), "中".repeat(4 * 1024 * 1024)] {
            let error = write_selected(Some(path.clone()), &content).unwrap_err();
            assert_eq!(error, "排查报告超过 10 MiB 限制");
            assert_eq!(fs::read_to_string(&path).unwrap(), exactly_limit);
        }
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[test]
    fn report_rejects_other_extensions_directories_and_missing_parent_safely() {
        let temp = tempfile::tempdir().unwrap();
        for name in ["private-token.json", "private-token.htm", "private-token"] {
            let path = temp.path().join(name);
            fs::write(&path, "old").unwrap();
            assert!(write_selected(Some(path.clone()), "new").is_err());
            assert_eq!(fs::read_to_string(path).unwrap(), "old");
        }
        let directory = temp.path().join("private-token.html");
        fs::create_dir(&directory).unwrap();
        assert!(write_selected(Some(directory.clone()), "new").is_err());
        assert!(directory.is_dir());
        let error = write_selected(
            Some(
                temp.path()
                    .join("private-token-missing")
                    .join("report.html"),
            ),
            "new",
        )
        .unwrap_err();
        assert_eq!(error, "保存排查报告失败，请检查文件路径、占用和权限");
        assert!(write_selected(Some(PathBuf::from("relative.html")), "new").is_err());
        assert!(write_selected(Some(temp.path().join("..").join("escape.html")), "new").is_err());
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 4);
    }

    #[test]
    fn report_html_does_not_become_a_project_import_or_export_extension() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("report.HTML");
        write_selected(Some(path.clone()), "<html></html>").unwrap();
        assert!(crate::project_files::read_project(&path).is_err());
        assert!(crate::project_files::write_project(&path, "{}").is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "<html></html>");
    }

    #[cfg(windows)]
    #[test]
    fn failed_report_replacement_preserves_the_existing_file_and_cleans_temporary_files() {
        use std::{fs::OpenOptions, os::windows::fs::OpenOptionsExt};
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("private-token.html");
        fs::write(&path, "old-report").unwrap();
        let held = OpenOptions::new()
            .read(true)
            .share_mode(1)
            .open(&path)
            .unwrap();
        let error = write_selected(Some(path.clone()), "new-report").unwrap_err();
        assert_eq!(error, "保存排查报告失败，请检查文件路径、占用和权限");
        assert_eq!(fs::read_to_string(path).unwrap(), "old-report");
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
        drop(held);
    }

    #[cfg(windows)]
    #[test]
    fn report_rejects_reparse_points_in_the_selected_file_or_ancestor_directory() {
        use std::os::windows::process::CommandExt;
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("real");
        let junction = temp.path().join("junction");
        fs::create_dir(&target).unwrap();
        let result = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&junction)
            .arg(&target)
            .creation_flags(0x0800_0000)
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let path = target.join("report.html");
        fs::write(&path, "old-report").unwrap();
        assert!(write_selected(Some(junction.join("report.html")), "new-report").is_err());
        // Also reject a reparse point occupying the selected file itself.
        let selected = temp.path().join("report.html");
        let renamed = fs::rename(&junction, &selected);
        assert!(renamed.is_ok());
        assert!(write_selected(Some(selected.clone()), "new-report").is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "old-report");
        fs::remove_dir(selected).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn report_rejects_file_and_parent_symlinks_without_touching_the_target() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("original.html");
        fs::write(&path, "old-report").unwrap();
        let link = temp.path().join("link.html");
        symlink(&path, &link).unwrap();
        assert!(write_selected(Some(link), "new-report").is_err());
        let directory = temp.path().join("link-dir");
        symlink(temp.path(), &directory).unwrap();
        assert!(write_selected(Some(directory.join("original.html")), "new-report").is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "old-report");
    }
}
