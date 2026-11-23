use tauri::Url;

fn allow_permission(is_microphone: bool, requesting_uri: &str, server_url: Option<&Url>) -> bool {
    if !is_microphone {
        return false;
    }
    let (Some(server_url), Ok(request)) = (server_url, Url::parse(requesting_uri)) else {
        return false;
    };
    request.scheme() == "http" && request.origin() == server_url.origin()
}

#[cfg(windows)]
pub(super) fn install(
    window: &tauri::WebviewWindow,
    sidecar: std::sync::Arc<super::Sidecar>,
) -> Result<(), Box<dyn std::error::Error>> {
    use webview2_com::{
        take_pwstr, PermissionRequestedEventHandler,
        Microsoft::Web::WebView2::Win32::{
            ICoreWebView2PermissionRequestedEventArgs3, COREWEBVIEW2_PERMISSION_KIND_MICROPHONE,
            COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
            COREWEBVIEW2_PERMISSION_STATE_DENY,
        },
    };
    use windows_core::Interface;

    let (tx, rx) = std::sync::mpsc::channel();
    window.with_webview(move |view| {
        // The webview owns the handler until it closes. Read the live URL so
        // restarting or stopping the sidecar also changes the permission scope.
        let result = unsafe {
            view.controller().CoreWebView2().and_then(|webview| {
                let mut token = 0;
                webview.add_PermissionRequested(
                    &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                        let Some(args) = args else { return Ok(()) };
                        let mut kind = COREWEBVIEW2_PERMISSION_KIND_UNKNOWN_PERMISSION;
                        let mut uri = Default::default();
                        let is_microphone = args.PermissionKind(&mut kind).is_ok()
                            && kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE;
                        let has_uri = is_microphone && args.Uri(&mut uri).is_ok();
                        let uri = take_pwstr(uri);
                        let server_url = sidecar.url.lock().ok().and_then(|url| url.clone());
                        // A cached grant could outlive the sidecar or be reused on another port binding.
                        let request_only = args
                            .cast::<ICoreWebView2PermissionRequestedEventArgs3>()
                            .and_then(|args| args.SetSavesInProfile(false))
                            .is_ok();
                        let allow = request_only
                            && has_uri
                            && allow_permission(is_microphone, &uri, server_url.as_ref());
                        args.SetState(if allow {
                            COREWEBVIEW2_PERMISSION_STATE_ALLOW
                        } else {
                            COREWEBVIEW2_PERMISSION_STATE_DENY
                        })
                    })),
                    &mut token,
                )
            })
        };
        let _ = tx.send(result);
    })?;
    // Called in Tauri setup on the UI thread, where wry runs with_webview inline.
    rx.try_recv()
        .map_err(|e| format!("WebView2 permission handler did not run: {e}"))?
        .map_err(|e| format!("Cannot install WebView2 permission policy: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_kind_and_origin_matrix() {
        let server = Url::parse("http://127.0.0.1:54321").unwrap();
        for (uri, same_origin) in [
            ("http://127.0.0.1:54321", true),
            ("http://127.0.0.1:54321/dashboard?q=1#voice", true),
            ("http://127.0.0.1:54322", false),
            ("http://127.0.0.1", false),
            ("http://localhost:54321", false),
            ("http://[::1]:54321", false),
            ("https://127.0.0.1:54321", false),
            ("http://127.0.0.1:54321@other.example/", false),
            ("http://other.example/?http://127.0.0.1:54321", false),
            ("http://tauri.localhost", false),
            ("blob:http://127.0.0.1:54321/id", false),
            ("about:blank", false),
            ("null", false),
            ("", false),
        ] {
            for is_microphone in [false, true] {
                assert_eq!(
                    allow_permission(is_microphone, uri, Some(&server)),
                    is_microphone && same_origin,
                    "is_microphone={is_microphone}, uri={uri:?}"
                );
                assert!(!allow_permission(is_microphone, uri, None));
            }
        }
    }

    #[test]
    fn restart_does_not_keep_the_previous_origin() {
        let previous = "http://127.0.0.1:54321";
        let current = "http://127.0.0.1:54322";
        let server = Url::parse(current).unwrap();
        assert!(!allow_permission(true, previous, Some(&server)));
        assert!(allow_permission(true, current, Some(&server)));
    }
}
