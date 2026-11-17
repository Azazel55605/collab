#[cfg(not(mobile))]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use tauri::{webview::NewWindowResponse, WebviewUrl, WebviewWindowBuilder};

    let port: u16 = std::env::args()
        .nth(1)
        .ok_or("Usage: source_editor LOOPBACK_PORT")?
        .parse()?;
    let url: tauri::Url = format!("http://127.0.0.1:{port}/").parse()?;
    let origin = url.origin();
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    context.config_mut().app.security.capabilities.clear();

    tauri::Builder::default()
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "source-editor-prototype", WebviewUrl::External(url))
                .title("Collab Source Editor Prototype")
                .inner_size(1120.0, 760.0)
                .focused(false)
                .on_navigation(move |url| url.origin() == origin && url.path() == "/")
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .build()?;
            Ok(())
        })
        .run(context)?;
    Ok(())
}

#[cfg(mobile)]
fn main() {
    eprintln!("The source editor prototype requires a desktop WebView.");
}
