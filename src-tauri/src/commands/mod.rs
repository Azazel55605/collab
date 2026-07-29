pub mod background;
pub mod calendar;
pub mod circuit;
pub mod collab;
pub mod crypto;
pub mod files;
pub mod index;
pub mod live_ws;
pub mod mobile;
pub mod notifications;
pub mod ocr;
pub mod replica;
pub mod server;
pub mod sheet;
pub mod templates;
pub mod ui;
pub mod update;
pub mod vault;
pub mod watcher;
pub mod web;

use std::path::PathBuf;
// `Path` is only used by the non-Android `app_config_dir`; importing it
// unconditionally warns as unused on the Android target.
#[cfg(not(target_os = "android"))]
use std::path::Path;

/// The application configuration directory (`%APPDATA%/collab` on Windows,
/// `~/.config/collab` on Unix desktop, and app-private files storage on
/// Android). Used for app-scoped templates/snippets and the native hosted-vault
/// replica store. The directory is created if missing.
#[cfg(target_os = "android")]
pub fn app_config_dir() -> Result<PathBuf, String> {
    let dir = android_files_dir()?.join("collab");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[cfg(not(target_os = "android"))]
pub fn app_config_dir() -> Result<PathBuf, String> {
    let dir = if let Ok(appdata) = std::env::var("APPDATA") {
        PathBuf::from(appdata).join("collab")
    } else {
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .map_err(|_| "Cannot determine home directory".to_string())?;
        Path::new(&home).join(".config").join("collab")
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[cfg(target_os = "android")]
fn android_files_dir() -> Result<PathBuf, String> {
    crate::android_jni::files_dir()
}
