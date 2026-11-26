//! Only the fixed OS-owned macOS directory aliases may bypass symlink rejection.
use std::path::Path;

pub(crate) fn is_system_alias(path: &Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        let target = match path.to_str() {
            Some("/var") => "/private/var",
            Some("/tmp") => "/private/tmp",
            Some("/etc") => "/private/etc",
            _ => return false,
        };
        std::fs::read_link(path).is_ok_and(|link| {
            let resolved = if link.is_absolute() {
                link
            } else {
                path.parent().unwrap_or(Path::new("/")).join(link)
            };
            resolved == Path::new(target)
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        false
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn macos_temp_aliases_work_but_user_symlinks_remain_rejected() {
        for path in ["/var", "/tmp", "/etc"] {
            assert!(is_system_alias(Path::new(path)), "missing macOS alias: {path}");
        }
        let temp = tempfile::tempdir().unwrap();
        let link = temp.path().join("alias");
        std::os::unix::fs::symlink("/private/tmp", &link).unwrap();
        assert!(!is_system_alias(&link));
        assert!(!is_system_alias(Path::new("/private/tmp")));
    }
}
