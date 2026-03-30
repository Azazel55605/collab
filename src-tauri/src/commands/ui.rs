/// Sets the WebView zoom level (HiDPI scale).
/// Pinch-to-zoom is blocked at the GTK gesture layer, so this is safe to call freely.
#[tauri::command]
pub async fn set_ui_zoom(zoom: f64, window: tauri::WebviewWindow) -> Result<(), String> {
    window.set_zoom(zoom).map_err(|e| e.to_string())
}
