use semver::Version;
use serde::{Deserialize, Serialize};
use std::{
    fs, io::{self, Read, Write}, path::{Path, PathBuf}, sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_updater::{Error as PluginError, Update, UpdaterExt};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

const CHECK_TIMEOUT: Duration = Duration::from_secs(15);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CACHED_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Debug)]
#[serde(default, rename_all = "camelCase")]
struct Settings {
    auto_check: bool,
    auto_install: bool,
}
impl Default for Settings {
    fn default() -> Self { Self { auto_check: true, auto_install: true } }
}
impl Settings {
    fn load(path: &Path) -> io::Result<Self> {
        match fs::read(path) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(Self::default()),
            Err(err) => Err(err),
        }
    }
    fn save(self, path: &Path) -> io::Result<()> {
        write_atomic(path, &serde_json::to_vec(&self)?)
    }
}

#[derive(Clone, Copy, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
enum Phase { Idle, Checking, UpToDate, Available, Downloading, Ready, Installing, Unsupported, Error }
impl Phase {
    fn working(self) -> bool { matches!(self, Self::Checking | Self::Downloading | Self::Installing) }
}

#[derive(Clone, Serialize)]
struct Available { version: String, notes: String, date: Option<String> }
#[derive(Clone, Serialize)]
struct Progress { downloaded: u64, total: Option<u64> }
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Busy { running: u64, waiting_for_human: u64 }
impl Busy {
    fn is_busy(self) -> bool { self.running > 0 || self.waiting_for_human > 0 }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    current: String,
    #[serde(flatten)]
    settings: Settings,
    state: Phase,
    #[serde(skip_serializing_if = "Option::is_none")]
    available: Option<Available>,
    #[serde(skip_serializing_if = "Option::is_none")]
    progress: Option<Progress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_check: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    busy: Option<Busy>,
}
impl Status {
    fn change(&mut self, state: Phase) {
        self.state = state;
        self.progress = None;
        self.error = None;
        self.busy = None;
    }
    fn failure(&mut self, message: &'static str) {
        self.change(Phase::Error);
        self.error = Some(message);
    }
    fn check_failed(&mut self, previous: Phase, message: &'static str) {
        if self.available.is_some() && matches!(previous, Phase::Ready | Phase::Available) {
            self.change(previous);
            self.error = Some(message);
        } else {
            self.available = None;
            self.failure(message);
        }
    }
    fn begin_install(&mut self, busy: Busy) -> bool {
        if busy.is_busy() {
            self.change(Phase::Ready);
            self.busy = Some(busy);
            self.error = Some("busy");
            false
        } else {
            self.change(Phase::Installing);
            true
        }
    }
}

type Reply = Result<Status, Status>;
struct Inner { status: Status, update: Option<Update> }
pub(crate) struct Updates {
    inner: Mutex<Inner>,
    settings_path: PathBuf,
    cache: PathBuf,
}
impl Updates {
    pub(crate) fn new(app: &AppHandle) -> tauri::Result<Self> {
        let settings_path = app.path().app_data_dir()?.join("updates.json");
        let cache = app.path().app_local_data_dir()?.join("updates");
        let settings = Settings::load(&settings_path);
        let invalid = settings.is_err();
        let mut status = Status {
            current: app.package_info().version.to_string(), settings: settings.unwrap_or_default(),
            state: Phase::Idle, available: None, progress: None, last_check: None, error: None, busy: None,
        };
        if invalid {
            status.settings.auto_install = false;
            status.failure("Could not read update settings.");
        }
        Ok(Self { inner: Mutex::new(Inner { status, update: None }), settings_path, cache })
    }
}

fn locked(app: &AppHandle) -> tauri::State<'_, Updates> { app.state::<Updates>() }
fn publish(app: &AppHandle, status: &Status) -> Status {
    let _ = app.emit_to(tauri::EventTarget::webview_window("main"), "update-status", status);
    status.clone()
}
fn reject(status: &Status, message: &'static str) -> Status {
    let mut response = status.clone();
    response.error = Some(message);
    response
}
fn failure(app: &AppHandle, message: &'static str) -> Status {
    let updates = locked(app);
    let mut inner = updates.inner.lock().unwrap();
    inner.status.failure(message);
    publish(app, &inner.status)
}
fn authorized(window: &WebviewWindow) -> bool {
    if window.label() != "main" { return false; }
    match (window.url().ok(), crate::server_url(window.app_handle())) {
        (Some(page), Some(server)) => page.origin() == server.origin(),
        _ => false,
    }
}
fn command_app(window: &WebviewWindow) -> Result<&AppHandle, Status> {
    let app = window.app_handle();
    if authorized(window) { Ok(app) } else {
        Err(reject(&locked(app).inner.lock().unwrap().status, "Update commands are only available in the main dashboard."))
    }
}

fn write_atomic(file: &Path, bytes: &[u8]) -> io::Result<()> {
    fs::create_dir_all(file.parent().unwrap())?;
    let temp = file.with_extension("partial");
    let result = (|| {
        // Create a new file so an unexpected link cannot redirect the write.
        let _ = fs::remove_file(&temp);
        let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
        output.write_all(bytes)?;
        output.sync_all()?;
        drop(output);
        fs::rename(&temp, file)
    })();
    if result.is_err() { let _ = fs::remove_file(temp); }
    result
}
fn newer(current: &Version, offered: &Version) -> bool { offered.cmp_precedence(current).is_gt() }
fn cache_version(file: &Path) -> Option<Version> {
    if file.extension()?.to_str()? != "bin" { return None; }
    Version::parse(file.file_stem()?.to_str()?).ok()
}
fn cache_path(cache: &Path, current: &Version, offered: &str) -> Option<PathBuf> {
    let offered = Version::parse(offered).ok()?;
    newer(current, &offered).then(|| cache.join(format!("{offered}.bin")))
}
fn prune_cache(cache: &Path, obsolete: impl Fn(&Version) -> bool) {
    if let Ok(entries) = fs::read_dir(cache) {
        for entry in entries.flatten() {
            let file = entry.path();
            if cache_version(&file).is_some_and(|version| obsolete(&version)) {
                let _ = fs::remove_file(file);
            }
        }
    }
}
fn remove_installed(cache: &Path, current: &Version) {
    prune_cache(cache, |version| !newer(current, version));
}
fn remove_old(cache: &Path, keep: &Version) {
    prune_cache(cache, |version| newer(version, keep));
}
fn read_cache(file: &Path) -> io::Result<Vec<u8>> {
    let meta = fs::symlink_metadata(file)?;
    if !meta.is_file() || meta.len() > MAX_CACHED_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "Invalid update file"));
    }
    let mut bytes = Vec::new();
    fs::File::open(file)?.take(MAX_CACHED_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_CACHED_BYTES {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "Update file is too large"));
    }
    Ok(bytes)
}
fn pkg_path(app: &AppHandle, update: &Update) -> Option<PathBuf> {
    cache_path(&locked(app).cache, &app.package_info().version, &update.version)
}
fn cached_bytes(app: &AppHandle, update: &Update) -> Option<Vec<u8>> {
    let file = pkg_path(app, update)?;
    match read_cache(&file) {
        Ok(bytes) if update.verify(&bytes).is_ok() => Some(bytes),
        Err(err) if err.kind() == io::ErrorKind::NotFound => None,
        _ => { let _ = fs::remove_file(file); None }
    }
}

enum Checked { Available(Box<Update>), UpToDate, Unsupported, Failed(&'static str) }
async fn check_release(app: &AppHandle, timeout: Duration) -> Checked {
    let updater = app.updater_builder().timeout(timeout)
        // Ask the plugin to resolve the target even for an equal/older release; enforce precedence below.
        .version_comparator(|_, _| true)
        .configure_client(|client| client.https_only(true).read_timeout(CHECK_TIMEOUT))
        .build();
    let result = match updater {
        Ok(updater) => match tokio::time::timeout(timeout, updater.check()).await {
            Ok(result) => result,
            Err(_) => return Checked::Failed("Update check timed out."),
        },
        Err(err) => Err(err),
    };
    match result {
        Ok(Some(update)) if pkg_path(app, &update).is_none() => Checked::UpToDate,
        Ok(Some(update)) if update.download_url.scheme() != "https" => Checked::Failed("The update download URL must use HTTPS."),
        Ok(Some(update)) => Checked::Available(Box::new(update)),
        Ok(None) => Checked::UpToDate,
        Err(PluginError::TargetNotFound(_) | PluginError::TargetsNotFound(_) | PluginError::UnsupportedOs | PluginError::UnsupportedArch) => Checked::Unsupported,
        Err(_) => Checked::Failed("Could not check for updates. Check your connection and try again."),
    }
}

fn format_date(date: OffsetDateTime) -> Option<String> { date.format(&Rfc3339).ok() }
async fn check(app: &AppHandle) -> Reply {
    let updates = locked(app);
    let previous = {
        let mut inner = updates.inner.lock().unwrap();
        let previous = inner.status.state;
        if previous.working() { return Ok(inner.status.clone()); }
        inner.status.change(Phase::Checking);
        publish(app, &inner.status);
        previous
    };
    let result = check_release(app, CHECK_TIMEOUT).await;
    let (status, download) = {
        let mut inner = updates.inner.lock().unwrap();
        inner.status.last_check = format_date(OffsetDateTime::now_utc());
        let mut download = None;
        match result {
            Checked::Available(update) => {
                let ready = cached_bytes(app, &update).is_some();
                inner.status.available = Some(Available { version: update.version.clone(), notes: update.body.as_deref().unwrap_or("").chars().take(32_768).collect(), date: update.date.and_then(format_date) });
                inner.status.change(if ready { Phase::Ready } else { Phase::Available });
                inner.update = Some(*update);
                if !ready && inner.status.settings.auto_install { download = begin_download(app, &mut inner); }
            }
            Checked::UpToDate | Checked::Unsupported => {
                inner.update = None;
                inner.status.available = None;
                inner.status.change(if matches!(result, Checked::UpToDate) { Phase::UpToDate } else { Phase::Unsupported });
            }
            Checked::Failed(message) => {
                // A failed fetch does not invalidate the last actionable release.
                inner.status.check_failed(previous, message);
                if inner.status.state == Phase::Error { inner.update = None; }
                return Err(publish(app, &inner.status));
            }
        }
        (publish(app, &inner.status), download)
    };
    if let Some(update) = download { spawn_download(app.clone(), update); }
    Ok(status)
}

fn begin_download(app: &AppHandle, inner: &mut Inner) -> Option<Update> {
    let update = inner.update.clone()?;
    inner.status.change(Phase::Downloading);
    inner.status.progress = Some(Progress { downloaded: 0, total: None });
    publish(app, &inner.status);
    Some(update)
}
fn spawn_download(app: AppHandle, mut update: Update) {
    tauri::async_runtime::spawn(async move {
        // Use an idle network timeout, not the manifest deadline, for large installers.
        update.timeout = None;
        let mut downloaded = 0u64;
        let mut last = Instant::now();
        let bytes = tokio::time::timeout(Duration::from_secs(1800), update.download(|len, total| {
            downloaded += len as u64;
            if last.elapsed() >= Duration::from_millis(150) || total == Some(downloaded) {
                last = Instant::now();
                let updates = locked(&app);
                let mut inner = updates.inner.lock().unwrap();
                inner.status.progress = Some(Progress { downloaded, total });
                publish(&app, &inner.status);
            }
        }, || {})).await;
        let Ok(Ok(bytes)) = bytes else { failure(&app, "Could not download or verify the update."); return; };
        let Some(file) = pkg_path(&app, &update) else { failure(&app, "Invalid update version."); return; };
        if bytes.len() as u64 > MAX_CACHED_BYTES || write_atomic(&file, &bytes).is_err() {
            failure(&app, "Could not cache the update."); return;
        }
        let updates = locked(&app);
        remove_old(&updates.cache, &Version::parse(&update.version).unwrap());
        let mut inner = updates.inner.lock().unwrap();
        inner.status.change(Phase::Ready);
        publish(&app, &inner.status);
    });
}

pub(crate) async fn periodic(app: AppHandle) {
    tokio::time::sleep(Duration::from_secs(30)).await;
    let mut interval = tokio::time::interval(Duration::from_secs(6 * 60 * 60));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        interval.tick().await;
        if crate::server_url(&app).is_some() && locked(&app).inner.lock().unwrap().status.settings.auto_check {
            let _ = check(&app).await;
        }
    }
}

pub(crate) async fn before_start(app: &AppHandle) {
    let updates = locked(app);
    let current = &app.package_info().version;
    remove_installed(&updates.cache, current);
    if !updates.inner.lock().unwrap().status.settings.auto_install ||
        !fs::read_dir(&updates.cache).into_iter().flatten().flatten().any(|e| cache_version(&e.path()).is_some_and(|v| newer(current, &v))) {
        return;
    }
    let Checked::Available(update) = check_release(app, STARTUP_TIMEOUT).await else { return; };
    let Some(bytes) = cached_bytes(app, &update) else { return; };
    if !crate::claim_shutdown(app) { return; }
    // No sidecar exists yet. On Windows install exits directly; other platforms need an explicit restart.
    if update.install(bytes).is_ok() { app.restart(); }
    crate::release_shutdown(app);
    failure(app, "Could not install the cached update. Scranton will start normally.");
}

#[tauri::command]
pub(crate) async fn update_status(window: WebviewWindow) -> Reply {
    let app = command_app(&window)?;
    Ok(locked(app).inner.lock().unwrap().status.clone())
}
#[tauri::command]
pub(crate) async fn update_check(window: WebviewWindow) -> Reply {
    check(command_app(&window)?).await
}
#[tauri::command]
pub(crate) async fn update_download(window: WebviewWindow) -> Reply {
    let app = command_app(&window)?;
    let updates = locked(app);
    let mut inner = updates.inner.lock().unwrap();
    if inner.status.state.working() || inner.status.state == Phase::Ready { return Ok(inner.status.clone()); }
    let Some(update) = begin_download(app, &mut inner) else { return Err(reject(&inner.status, "No update is available to download.")); };
    spawn_download(app.clone(), update);
    Ok(inner.status.clone())
}
#[tauri::command]
pub(crate) async fn update_set_settings(window: WebviewWindow, auto_check: Option<bool>, auto_install: Option<bool>) -> Reply {
    let app = command_app(&window)?;
    let updates = locked(app);
    let mut inner = updates.inner.lock().unwrap();
    let previous = inner.status.settings;
    let settings = Settings { auto_check: auto_check.unwrap_or(previous.auto_check), auto_install: auto_install.unwrap_or(previous.auto_install) };
    if settings.save(&updates.settings_path).is_err() { return Err(reject(&inner.status, "Could not save update settings.")); }
    inner.status.settings = settings;
    publish(app, &inner.status);
    if settings.auto_install && !previous.auto_install && inner.status.state == Phase::Available {
        if let Some(update) = begin_download(app, &mut inner) { spawn_download(app.clone(), update); }
    }
    Ok(inner.status.clone())
}

async fn app_busy(url: &tauri::Url, guard: uuid::Uuid) -> Option<Busy> {
    let response = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(3)).build().ok()?
        .get(url.join("/api/app/busy").ok()?)
        .header("X-Scranton-Client", "1")
        .header("X-Scranton-Update-Guard", guard.to_string())
        .send().await.ok()?.error_for_status().ok()?;
    response.json().await.ok()
}

#[tauri::command]
pub(crate) async fn update_install(window: WebviewWindow) -> Reply {
    let app = command_app(&window)?;
    let updates = locked(app);
    let update = {
        let mut inner = updates.inner.lock().unwrap();
        if inner.status.state != Phase::Ready { return Err(reject(&inner.status, "Download the update before installing.")); }
        let Some(update) = inner.update.clone() else { return Err(reject(&inner.status, "No update is ready.")); };
        inner.status.change(Phase::Installing);
        publish(app, &inner.status);
        update
    };
    let Some(bytes) = cached_bytes(app, &update) else { return Err(failure(app, "The cached update could not be verified. Download it again.")); };
    let Some(url) = crate::server_url(app) else { return Err(failure(app, "Could not confirm the app server is idle.")); };
    let busy = match crate::update_guard(app) {
        Some(guard) => app_busy(&url, guard).await,
        None => None,
    };
    let Some(busy) = busy else {
        let mut inner = updates.inner.lock().unwrap();
        inner.status.change(Phase::Ready);
        inner.status.error = Some("Could not confirm the app server is idle.");
        return Err(publish(app, &inner.status));
    };
    {
        let mut inner = updates.inner.lock().unwrap();
        if !inner.status.begin_install(busy) { return Err(publish(app, &inner.status)); }
    }
    if !crate::claim_shutdown(app) { return Err(failure(app, "Scranton is already shutting down.")); }
    let handle = app.clone();
    let installer_app = handle.clone();
    // The native installer may exit the process; do not run it on the webview thread.
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::shutdown_sidecar(&installer_app);
        update.install(bytes)
    }).await;
    if matches!(result, Ok(Ok(()))) { app.restart(); }
    let status = failure(app, "Could not install the update. The app server will restart.");
    crate::release_shutdown(app);
    crate::supervise(handle);
    Err(status)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.scratch/desktop-updater").join(uuid::Uuid::new_v4().to_string());
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Scratch { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

    fn status() -> Status {
        Status { current: "1.0.0".into(), settings: Settings::default(), state: Phase::Idle, available: None, progress: None, last_check: None, error: None, busy: None }
    }

    #[test]
    fn settings_defaults_partial_and_atomic_replacement() {
        let dir = Scratch::new();
        let file = dir.0.join("updates.json");
        assert_eq!(Settings::load(&file).unwrap(), Settings { auto_check: true, auto_install: true });
        fs::write(&file, br#"{"autoCheck":false}"#).unwrap();
        assert_eq!(Settings::load(&file).unwrap(), Settings { auto_check: false, auto_install: true });
        let settings = Settings { auto_check: true, auto_install: false };
        settings.save(&file).unwrap();
        assert_eq!(Settings::load(&file).unwrap(), settings);
        assert_eq!(serde_json::from_slice::<serde_json::Value>(&fs::read(&file).unwrap()).unwrap(), serde_json::json!({"autoCheck":true,"autoInstall":false}));
        fs::write(&file, "invalid JSON").unwrap();
        assert!(Settings::load(&file).is_err());
    }

    #[test]
    fn status_transitions_clear_transient_fields_and_serialize_progress() {
        let mut s = status();
        assert!(!s.state.working());
        s.change(Phase::Checking);
        assert!(s.state.working());
        s.change(Phase::Available);
        assert!(!s.state.working());
        s.change(Phase::Downloading);
        s.progress = Some(Progress { downloaded: 12, total: None });
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json, serde_json::json!({"current":"1.0.0","autoCheck":true,"autoInstall":true,"state":"downloading","progress":{"downloaded":12,"total":null}}));
        s.failure("offline");
        assert_eq!(s.state, Phase::Error);
        assert!(s.progress.is_none());
        s.change(Phase::UpToDate);
        assert!(s.error.is_none());
        assert_eq!(serde_json::to_value(&s).unwrap()["state"], "up_to_date");
    }

    #[test]
    fn failed_check_keeps_actionable_release_and_reports_error() {
        for (phase, name) in [(Phase::Ready, "ready"), (Phase::Available, "available")] {
            let mut s = status();
            s.change(phase);
            s.available = Some(Available { version: "1.1.0".into(), notes: "Release notes".into(), date: None });
            let available = serde_json::to_value(&s).unwrap()["available"].clone();
            let previous = s.state;
            s.change(Phase::Checking);
            s.check_failed(previous, "offline");
            let json = serde_json::to_value(&s).unwrap();
            assert_eq!(json["state"], name);
            assert_eq!(json["available"], available);
            assert_eq!(json["error"], "offline");
        }
        let mut s = status();
        s.change(Phase::Checking);
        s.check_failed(Phase::Idle, "offline");
        assert_eq!(s.state, Phase::Error);
        assert_eq!(s.error, Some("offline"));
    }

    #[test]
    fn startup_prunes_installed_and_older_versions_but_keeps_newer_downloads() {
        let dir = Scratch::new();
        let current = Version::parse("1.0.0").unwrap();
        let obsolete = ["0.9.0.bin", "1.0.0-rc.1.bin", "1.0.0.bin", "1.0.0+build.2.bin"];
        let keep = ["1.0.1.bin", "1.1.0.bin", "not-an-update.bin", "1.0.0.partial"];
        for name in obsolete.into_iter().chain(keep) { fs::write(dir.0.join(name), name).unwrap(); }
        remove_installed(&dir.0, &current);
        for name in obsolete { assert!(!dir.0.join(name).exists(), "kept {name}"); }
        for name in keep { assert!(dir.0.join(name).is_file(), "removed {name}"); }
    }

    #[test]
    fn cache_selects_only_the_exact_offered_newer_version_and_removes_older_files() {
        let dir = Scratch::new();
        let current = Version::parse("1.0.0").unwrap();
        assert!(cache_path(&dir.0, &current, "1.0.0+build.2").is_none());
        assert!(cache_path(&dir.0, &current, "1.0.0").is_none());
        assert!(cache_path(&dir.0, &current, "0.9.0").is_none());
        assert!(cache_path(&dir.0, &current, "../9.9.9").is_none());
        for name in ["1.0.0.bin", "1.1.0.bin", "1.2.0.bin", "not-an-update.bin"] { fs::write(dir.0.join(name), name).unwrap(); }
        let offered = cache_path(&dir.0, &current, "1.3.0").unwrap();
        assert_eq!(read_cache(&offered).unwrap_err().kind(), io::ErrorKind::NotFound);
        let offered = cache_path(&dir.0, &current, "1.1.0").unwrap();
        assert_eq!(read_cache(&offered).unwrap(), b"1.1.0.bin");
        remove_old(&dir.0, &Version::parse("1.2.0").unwrap());
        assert!(!offered.exists() && !dir.0.join("1.0.0.bin").exists());
        assert!(dir.0.join("1.2.0.bin").exists() && dir.0.join("not-an-update.bin").exists());
    }

    #[test]
    fn install_refuses_runs_or_human_questions_and_returns_counts() {
        let mut s = status();
        for (running, waiting_for_human) in [(1, 0), (0, 2), (1, 2)] {
            let busy = Busy { running, waiting_for_human };
            assert!(!s.begin_install(busy));
            assert_eq!(s.state, Phase::Ready);
            assert_eq!(s.busy, Some(busy));
            assert_eq!(s.error, Some("busy"));
            assert_eq!(serde_json::to_value(&s).unwrap()["busy"], serde_json::json!({"running":running,"waitingForHuman":waiting_for_human}));
        }
        assert!(s.begin_install(Busy { running: 0, waiting_for_human: 0 }));
        assert_eq!(s.state, Phase::Installing);
        assert!(s.busy.is_none() && s.error.is_none());
        assert!(serde_json::from_str::<Busy>(r#"{"running":0}"#).is_err());
    }
}
