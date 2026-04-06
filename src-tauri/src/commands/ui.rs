/// Sets the WebView zoom level (HiDPI scale).
/// Pinch-to-zoom is blocked at the GTK gesture layer, so this is safe to call freely.
#[tauri::command]
pub async fn set_ui_zoom(zoom: f64, window: tauri::WebviewWindow) -> Result<(), String> {
    window.set_zoom(zoom).map_err(|e| e.to_string())
}

/// Returns true when running inside an AppImage bundle.
/// The frontend uses this to disable CSS backdrop-filter effects that don't
/// render correctly when DMA-BUF GPU compositing is unavailable.
#[tauri::command]
pub fn is_appimage() -> bool {
    #[cfg(target_os = "linux")]
    { std::env::var_os("APPIMAGE").is_some() }
    #[cfg(not(target_os = "linux"))]
    { false }
}

/// Returns true when the AppImage blur compatibility fallback is explicitly enabled.
/// Set `COLLAB_APPIMAGE_DISABLE_BLUR=1` to opt into the old no-blur behavior.
#[tauri::command]
pub fn should_disable_blur() -> bool {
    matches!(
        std::env::var("COLLAB_APPIMAGE_DISABLE_BLUR").ok().as_deref(),
        Some("1") | Some("true") | Some("TRUE") | Some("yes") | Some("YES")
    )
}
