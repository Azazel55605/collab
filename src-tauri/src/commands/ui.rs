/// Sets the WebView zoom level (HiDPI scale).
/// Pinch-to-zoom is blocked at the GTK gesture layer, so this is safe to call freely.
#[tauri::command]
pub async fn set_ui_zoom(zoom: f64, window: tauri::WebviewWindow) -> Result<(), String> {
    window.set_zoom(zoom).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
pub struct NativeDropViewport {
    width: f64,
    height: f64,
}

/// Wry's drop points use the platform view's units, not uniformly physical pixels.
/// Preserve the bounds' units: GTK/WKWebView are logical, WebView2 is physical.
/// Tauri exposes these bounds only on desktop; mobile has no native OS file-drop
/// coordinate contract and must not substitute unrelated window dimensions.
#[tauri::command]
pub async fn native_drop_viewport(webview: tauri::Webview) -> Result<NativeDropViewport, String> {
    #[cfg(desktop)]
    {
        let bounds = webview.bounds().map_err(|error| error.to_string())?;
        let (width, height) = match bounds.size {
            tauri::Size::Logical(size) => (size.width, size.height),
            tauri::Size::Physical(size) => (size.width as f64, size.height as f64),
        };
        if width <= 0.0 || height <= 0.0 {
            return Err("The native drop viewport is not available.".into());
        }
        Ok(NativeDropViewport { width, height })
    }
    #[cfg(mobile)]
    {
        let _ = webview;
        Err("Native file-drop coordinates are only available on desktop.".into())
    }
}

/// Returns the host operating system (`std::env::consts::OS`, e.g. "linux",
/// "windows", "macos"). The frontend uses this to show OS-specific controls such
/// as the Linux-only "keep me signed in across reboots" credential-store choice.
#[tauri::command]
pub fn host_os() -> String {
    std::env::consts::OS.to_string()
}

/// Returns true when running inside an AppImage bundle.
/// The frontend uses this to disable CSS backdrop-filter effects that don't
/// render correctly when DMA-BUF GPU compositing is unavailable.
#[tauri::command]
pub fn is_appimage() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("APPIMAGE").is_some()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// Returns true when running inside a Flatpak sandbox.
/// The frontend uses this to disable the in-app updater and show Flatpak-specific
/// distribution guidance instead of GitHub-release based updates.
#[tauri::command]
pub fn is_flatpak() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("FLATPAK_ID").is_some()
    }
    #[cfg(not(target_os = "linux"))]
    {
        false
    }
}

/// Returns true when the AppImage blur compatibility fallback is explicitly enabled.
/// Set `COLLAB_APPIMAGE_DISABLE_BLUR=1` to opt into the old no-blur behavior.
#[tauri::command]
pub fn should_disable_blur() -> bool {
    matches!(
        std::env::var("COLLAB_APPIMAGE_DISABLE_BLUR")
            .ok()
            .as_deref(),
        Some("1") | Some("true") | Some("TRUE") | Some("yes") | Some("YES")
    )
}
