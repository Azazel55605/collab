#[cfg(not(mobile))]
mod source;

#[cfg(not(mobile))]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use std::{path::PathBuf, sync::Arc};
    use tauri::{webview::NewWindowResponse, WebviewUrl, WebviewWindowBuilder};

    let mut args = std::env::args_os().skip(1);
    let directory = args
        .next()
        .map(PathBuf::from)
        .ok_or("Usage: media-playback FIXTURE_DIRECTORY [--verify]")?;
    let verify = match args.next() {
        None => false,
        Some(arg) if arg == "--verify" => true,
        _ => return Err("Usage: media-playback FIXTURE_DIRECTORY [--verify]".into()),
    };
    if args.next().is_some() {
        return Err("Usage: media-playback FIXTURE_DIRECTORY [--verify]".into());
    }
    let probe = Arc::new(source::Probe::open(&directory)?);
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))?;
    listener.set_nonblocking(true)?;
    let address = listener.local_addr()?;
    let url: tauri::Url = format!(
        "http://{address}/{}/{}",
        probe.token,
        if verify { "?verify" } else { "" }
    )
    .parse()?;
    let allowed_origin = url.origin();
    let allowed_path = url.path().to_owned();
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows.clear();
    context.config_mut().app.security.capabilities.clear();
    let router = source::router(probe, address.to_string());
    tauri::Builder::default()
        .setup(move |app| {
            tauri::async_runtime::spawn(async move {
                let listener = tokio::net::TcpListener::from_std(listener)?;
                axum::serve(listener, router).await
            });
            WebviewWindowBuilder::new(app, "media-prototype", WebviewUrl::External(url))
                .title("Collab Media Playback Prototype")
                .inner_size(920.0, 850.0)
                .on_navigation(move |url| {
                    url.origin() == allowed_origin && url.path() == allowed_path
                })
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .build()?;
            Ok(())
        })
        .run(context)?;
    Ok(())
}

#[cfg(mobile)]
fn main() {
    eprintln!("The media playback prototype requires a desktop WebView.");
}
