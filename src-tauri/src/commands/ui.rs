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
