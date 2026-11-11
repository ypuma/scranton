use std::path::{Path, PathBuf};

pub const TARGET: &str = env!("SCRANTON_RUST_TARGET");

pub fn node_filename(target: &str, development: bool) -> Result<String, String> {
    let suffix = match target {
        "x86_64-pc-windows-msvc" => ".exe",
        "aarch64-apple-darwin" | "x86_64-apple-darwin"
        | "x86_64-unknown-linux-gnu" | "aarch64-unknown-linux-gnu" => "",
        _ => return Err(format!("Unsupported desktop target: {target}")),
    };
    Ok(if development { format!("scranton-node-{target}{suffix}") } else { format!("scranton-node{suffix}") })
}

pub fn node_path(target: &str, development: bool, manifest: &Path, executable: &Path) -> Result<PathBuf, String> {
    let name = node_filename(target, development)?;
    if development { Ok(manifest.join("binaries").join(name)) }
    else {
        // Tauri 2.12.4 strips the target suffix and places externalBin beside the main executable:
        // Contents/MacOS on macOS, usr/bin for deb and the mounted AppImage, install dir on Windows.
        Ok(executable.parent().ok_or("Desktop executable has no parent directory")?.join(name))
    }
}

#[cfg(any(target_os = "macos", test))]
pub fn sidecar_path(target: &str, inherited: &str, home: Option<&str>) -> String {
    if !matches!(target, "aarch64-apple-darwin" | "x86_64-apple-darwin") {
        return inherited.to_owned();
    }
    let mut entries: Vec<&str> = Vec::new();
    let docker_home = home.filter(|home| home.starts_with('/') && !home.contains(':'))
        .map(|home| format!("{}/.docker/bin", home.trim_end_matches('/')));
    // Append known native tool locations without executing login shells or changing host state.
    for entry in inherited.split(':').chain([
        "/usr/local/bin", "/opt/homebrew/bin", "/Applications/Docker.app/Contents/Resources/bin",
    ]).chain(docker_home.as_deref()) {
        if !entry.is_empty() && !entries.contains(&entry) { entries.push(entry); }
    }
    entries.join(":")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finder_path_reaches_native_tools() {
        let finder = "/usr/bin:/bin:/usr/sbin:/sbin";
        for target in ["aarch64-apple-darwin", "x86_64-apple-darwin"] {
            let expected = format!("{finder}:/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:/Users/Zoë 工/.docker/bin");
            assert_eq!(sidecar_path(target, finder, Some("/Users/Zoë 工")), expected);
            assert_eq!(sidecar_path(target, &format!(":{finder}::/usr/bin:/usr/local/bin:"), Some("/Users/Zoë 工/")), expected);
            assert_eq!(sidecar_path(target, &expected, Some("/Users/Zoë 工")), expected);
            assert_eq!(sidecar_path(target, "", None), "/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin");
            assert!(!sidecar_path(target, finder, Some("relative")).contains("relative"));
            assert!(!sidecar_path(target, finder, Some("/bad:home")).contains("bad"));
            assert!(sidecar_path(target, "/custom/工具:/bin:/custom/工具", None).starts_with("/custom/工具:/bin:"));
        }
        for target in ["x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"] {
            for inherited in ["", ":/usr/bin::/usr/bin:", r"C:\Tools;C:\Windows"] {
                assert_eq!(sidecar_path(target, inherited, Some("/Users/Zoë 工")), inherited);
            }
        }
    }

    #[test]
    fn target_paths() {
        for target in ["x86_64-pc-windows-msvc", "aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"] {
            let suffix = if target.contains("windows") { ".exe" } else { "" };
            assert_eq!(node_path(target, true, Path::new("native"), Path::new("unused")).unwrap(), Path::new("native/binaries").join(format!("scranton-node-{target}{suffix}")));
            for dir in ["install", "Scranton.app/Contents/MacOS", "/usr/bin", "/tmp/.mount_Scranton/usr/bin"] {
                assert_eq!(node_path(target, false, Path::new("unused"), &Path::new(dir).join("scranton-desktop")).unwrap(), Path::new(dir).join(format!("scranton-node{suffix}")));
            }
        }
        assert!(node_filename("universal-apple-darwin", true).is_err());
        assert!(node_filename("x86_64-unknown-linux-musl", false).is_err());
        assert!(node_path(TARGET, false, Path::new("unused"), Path::new("/")).is_err());
    }
}
