// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // When running as an AppImage, WebKitGTK's DMA-BUF renderer causes visual
    // blurring/corruption because the AppImage's bundled libs conflict with the
    // host GPU stack. These env vars must be set before WebKit initialises
    // (i.e. before Builder::default()), so they go here rather than in setup().
    #[cfg(target_os = "linux")]
    if std::env::var_os("APPIMAGE").is_some() {
        // Fixes blurring/compositing corruption seen in AppImage but not in the
        // installed binary (which uses the system WebKitGTK linked against the
        // host GPU drivers directly).
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");

        // Do NOT force GDK_SCALE or GDK_DPI_SCALE here.  On Wayland (e.g.
        // Hyprland) the compositor communicates the monitor scale via the
        // Wayland protocol, not via env vars — so these vars are typically
        // absent from the session environment even on HiDPI displays.
        // Forcing them to "1" hard-codes 1× rendering and breaks HiDPI.
        // The compiled binary works because it links the system WebKitGTK
        // which speaks the Wayland fractional-scale protocol natively; the
        // AppImage's bundled GTK may fall back to Xwayland, in which case
        // the user can set GDK_SCALE themselves if needed.
    }

    collab_lib::run()
}
