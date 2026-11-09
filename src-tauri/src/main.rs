#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    io::{BufRead, BufReader, Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpStream},
    process::{Child, Command, Stdio},
    sync::{atomic::{AtomicBool, Ordering}, mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{menu::{Menu, MenuItem}, tray::TrayIconBuilder, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[derive(Default)]
struct Sidecar {
    child: Mutex<Option<Child>>,
    stopping: AtomicBool,
}

fn hidden(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    command
}

fn stop_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        if let Ok(mut killer) = hidden(Command::new("taskkill").args([
            "/PID", &child.id().to_string(), "/T", "/F",
        ])).stdout(Stdio::null()).stderr(Stdio::null()).spawn() {
            let until = Instant::now() + Duration::from_secs(2);
            while matches!(killer.try_wait(), Ok(None)) && Instant::now() < until {
                thread::sleep(Duration::from_millis(50));
            }
            let _ = killer.kill();
            let _ = killer.wait();
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn shutdown(app: &tauri::AppHandle) {
    let state = app.state::<Arc<Sidecar>>();
    if state.stopping.swap(true, Ordering::SeqCst) { return; }
    let state = state.inner().clone();
    let app = app.clone();
    thread::spawn(move || {
        if let Some(mut child) = state.child.lock().unwrap().take() {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(b"quit\n");
                let _ = stdin.flush();
            }
            let until = Instant::now() + Duration::from_secs(5);
            while matches!(child.try_wait(), Ok(None)) && Instant::now() < until {
                thread::sleep(Duration::from_millis(50));
            }
            if !matches!(child.try_wait(), Ok(Some(_))) { stop_tree(&mut child); }
        }
        app.exit(0);
    });
}

fn pending_human(url: &tauri::Url) -> Option<bool> {
    let port = url.port()?;
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let timeout = Duration::from_millis(500);
    let mut stream = TcpStream::connect_timeout(&address, timeout).ok()?;
    stream.set_read_timeout(Some(timeout)).ok()?;
    stream.set_write_timeout(Some(timeout)).ok()?;
    // HTTP/1.0 avoids chunked framing; close delimits this bounded local response.
    write!(stream, "GET /api/control HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nX-Scranton-Client: 1\r\n\r\n").ok()?;
    let mut response = String::new();
    stream.take(131073).read_to_string(&mut response).ok()?;
    if response.len() > 131072 { return None; }
    let (headers, body) = response.split_once("\r\n\r\n")?;
    if !headers.lines().next()?.contains(" 200 ") { return None; }
    let control: serde_json::Value = serde_json::from_str(body).ok()?;
    Some(control["enabled"] == true && (control["pendingHuman"].is_object() || control["pendingHuman"].as_u64().unwrap_or(0) > 0))
}

fn startup(app: &tauri::AppHandle) -> Result<(tauri::Url, Arc<Mutex<Vec<u8>>>), String> {
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let workspace = app.path().document_dir().map_err(|e| e.to_string())?
        .join("Scranton").join("workspace");
    std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
    let app_dir = if cfg!(debug_assertions) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("staged/app")
    } else { resources.join("app") };
    let node = if cfg!(debug_assertions) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries/node-x86_64-pc-windows-msvc.exe")
    } else {
        std::env::current_exe().map_err(|e| e.to_string())?.with_file_name("node.exe")
    };
    let mut command = Command::new(&node);
    // Node loads this before any module, so run children inherit the same keys.
    command.arg(format!("--env-file-if-exists={}", data.join(".env").display()))
        .arg(app_dir.join("bin/scranton.js"))
        .args(["app-server", "--data"]).arg(&data)
        .arg("--legacy-workspace").arg(&workspace)
        .env("SCRANTON_ENV_FILE", data.join(".env"))
        .current_dir(&app_dir)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let state = app.state::<Arc<Sidecar>>();
    let mut slot = state.child.lock().unwrap();
    if state.stopping.load(Ordering::SeqCst) { return Err("Startup cancelled".into()); }
    let mut child = hidden(&mut command).spawn().map_err(|e| format!("Cannot start bundled Node: {e}"))?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    // Register before waiting for readiness so a tray quit during startup cannot orphan Node.
    *slot = Some(child);
    drop(slot);
    let tail = Arc::new(Mutex::new(Vec::<u8>::new()));
    let output_tail = tail.clone();
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut bytes = [0; 1024];
        while let Ok(n) = reader.read(&mut bytes) {
            if n == 0 { break; }
            let mut tail = output_tail.lock().unwrap();
            tail.extend_from_slice(&bytes[..n]);
            if tail.len() > 8192 { let end = tail.len() - 8192; tail.drain(..end); }
        }
    });
    let (tx, rx) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let result = reader.by_ref().take(65536).read_line(&mut line).map(|_| line);
        let _ = tx.send(result);
        // Drain subsequent output without keeping an unbounded log.
        let _ = std::io::copy(&mut reader, &mut std::io::sink());
    });
    let ready = rx.recv_timeout(Duration::from_secs(20))
        .map_err(|_| "App server did not become ready within 20 seconds".to_string())
        .and_then(|v| v.map_err(|e| e.to_string()))
        .and_then(|line| serde_json::from_str::<serde_json::Value>(&line).map_err(|e| format!("Invalid ready line: {e}")))
        .and_then(|value| {
            if value["ready"] != true { return Err("App server did not report ready".into()); }
            let url = value["url"].as_str().ok_or("Ready line has no URL")?;
            let url = tauri::Url::parse(url).map_err(|e| e.to_string())?;
            if url.scheme() != "http" || url.host_str() != Some("127.0.0.1")
                || url.port().is_none() || !url.username().is_empty() || url.password().is_some() {
                return Err("App server returned a non-loopback URL".into());
            }
            Ok(url)
        });
    match ready {
        Ok(url) => {
            if state.stopping.load(Ordering::SeqCst) { return Err("Startup cancelled".into()); }
            Ok((url, tail))
        }
        Err(error) => {
            if let Some(mut child) = state.child.lock().unwrap().take() { stop_tree(&mut child); }
            let tail = tail.lock().unwrap();
            Err(format!("{error}\n\n{}", String::from_utf8_lossy(&tail)))
        }
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show(); let _ = window.unminimize(); let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default()
            .with_state_flags(tauri_plugin_window_state::StateFlags::SIZE | tauri_plugin_window_state::StateFlags::POSITION | tauri_plugin_window_state::StateFlags::MAXIMIZED)
            .build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(Arc::new(Sidecar::default()))
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "Show / Hide", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Scranton").menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => if let Some(window) = app.get_webview_window("main") {
                        if window.is_visible().unwrap_or(false) { let _ = window.hide(); }
                        else { let _ = window.show(); let _ = window.unminimize(); let _ = window.set_focus(); }
                    },
                    "quit" => shutdown(app),
                    _ => {}
                }).build(app)?;
            let handle = app.handle().clone();
            thread::spawn(move || loop {
                let (url, tail) = match startup(&handle) {
                    Ok(ready) => ready,
                    Err(error) => {
                        if handle.state::<Arc<Sidecar>>().stopping.load(Ordering::SeqCst) { return; }
                        handle.dialog().message(error).title("Scranton startup failed")
                            .kind(MessageDialogKind::Error).blocking_show();
                        shutdown(&handle);
                        return;
                    }
                };
                if let Some(window) = handle.get_webview_window("main") {
                    if let Err(error) = window.navigate(url.clone()) {
                        handle.dialog().message(error.to_string()).title("Scranton startup failed")
                            .kind(MessageDialogKind::Error).blocking_show();
                        shutdown(&handle);
                        return;
                    } else { let _ = window.show(); }
                }
                let state = handle.state::<Arc<Sidecar>>();
                let failure = loop {
                    thread::sleep(Duration::from_secs(1));
                    if state.stopping.load(Ordering::SeqCst) { return; }
                    let exited = {
                        let mut slot = state.child.lock().unwrap();
                        match slot.as_mut().map(Child::try_wait) {
                            Some(Ok(None)) => None,
                            Some(Ok(Some(status))) => { slot.take(); Some(format!("App server exited unexpectedly ({status}).")) },
                            Some(Err(error)) => {
                                if let Some(mut child) = slot.take() { stop_tree(&mut child); }
                                Some(format!("Cannot monitor app server: {error}"))
                            },
                            None => return,
                        }
                    };
                    let paused = exited.is_none() && pending_human(&url).unwrap_or(false);
                    if let Some(tray) = handle.tray_by_id("main") {
                        let _ = tray.set_tooltip(Some(if paused { "Scranton — Human needed" } else { "Scranton" }));
                    }
                    if let Some(error) = exited { break error; }
                };
                if state.stopping.load(Ordering::SeqCst) { return; }
                let stderr = String::from_utf8_lossy(&tail.lock().unwrap()).into_owned();
                let restart = handle.dialog().message(format!("{failure}\n\n{stderr}\n\nRestart the app server?"))
                    .title("Scranton app server stopped").kind(MessageDialogKind::Error)
                    .buttons(MessageDialogButtons::OkCancelCustom("Restart".into(), "Quit".into()))
                    .blocking_show();
                if !restart { shutdown(&handle); return; }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                shutdown(window.app_handle());
            }
        })
        .build(tauri::generate_context!()).expect("Cannot initialize Scranton desktop");
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            if !app.state::<Arc<Sidecar>>().stopping.load(Ordering::SeqCst) {
                api.prevent_exit(); shutdown(app);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn control_response(status: &str, body: &str) -> Option<bool> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let response = format!("HTTP/1.0 {status}\r\nConnection: close\r\n\r\n{body}");
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                request.push_str(&line);
                if line == "\r\n" { break; }
            }
            assert!(request.starts_with("GET /api/control HTTP/1.0\r\n"));
            assert!(request.contains("X-Scranton-Client: 1\r\n"));
            assert!(request.contains(&format!("Host: 127.0.0.1:{port}\r\n")));
            stream.write_all(response.as_bytes()).unwrap();
        });
        let result = pending_human(&tauri::Url::parse(&format!("http://127.0.0.1:{port}")).unwrap());
        server.join().unwrap();
        result
    }

    #[test]
    fn tray_uses_live_pending_human() {
        assert_eq!(control_response("200 OK", r#"{"enabled":true,"pendingHuman":{"requestSeq":7}}"#), Some(true));
        assert_eq!(control_response("200 OK", r#"{"enabled":true,"running":2,"pendingHuman":1}"#), Some(true));
        assert_eq!(control_response("200 OK", r#"{"enabled":true,"running":2,"pendingHuman":0}"#), Some(false));
        // A killed run can leave state.json paused; only live control is authoritative.
        assert_eq!(control_response("200 OK", r#"{"enabled":true,"pendingHuman":null}"#), Some(false));
        assert_eq!(control_response("200 OK", r#"{"enabled":false}"#), Some(false));
    }

    #[test]
    fn tray_fails_closed_on_bad_control_response() {
        assert_eq!(control_response("503 Unavailable", r#"{"pendingHuman":{}}"#), None);
        assert_eq!(control_response("200 OK", "invalid json"), None);
        assert_eq!(control_response("200 OK", "{}"), Some(false));
    }
}
