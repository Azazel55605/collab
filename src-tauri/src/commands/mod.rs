pub mod calendar;
pub mod circuit;
pub mod collab;
pub mod crypto;
pub mod files;
pub mod index;
pub mod live_ws;
pub mod mobile;
pub mod ocr;
pub mod replica;
pub mod server;
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
    use jni::objects::{JObject, JString};
    use jni::{JNIEnv, JavaVM};
    use std::mem::ManuallyDrop;

    fn clear_exception(env: &mut JNIEnv<'_>) {
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_describe();
            let _ = env.exception_clear();
        }
    }

    let context = ndk_context::android_context();
    let java_vm = unsafe { JavaVM::from_raw(context.vm().cast()) }
        .map_err(|_| "Could not access the Android Java VM.".to_string())?;
    let java_vm = ManuallyDrop::new(java_vm);
    let mut env = java_vm
        .attach_current_thread()
        .map_err(|_| "Could not attach to the Android Java VM.".to_string())?;
    // `ndk_context` owns this global context reference. Borrow it for this
    // lookup without dropping/deleting a reference we did not create.
    let context = ManuallyDrop::new(unsafe { JObject::from_raw(context.context().cast()) });
    let files_dir = env
        .call_method(&*context, "getFilesDir", "()Ljava/io/File;", &[])
        .map_err(|_| {
            clear_exception(&mut env);
            "Could not access the Android app files directory.".to_string()
        })?
        .l()
        .map_err(|_| "Android returned an invalid app files directory.".to_string())?;
    let path = env
        .call_method(&files_dir, "getAbsolutePath", "()Ljava/lang/String;", &[])
        .map_err(|_| {
            clear_exception(&mut env);
            "Could not read the Android app files directory path.".to_string()
        })?
        .l()
        .map_err(|_| "Android returned an invalid app files directory path.".to_string())?;
    let path = JString::from(path);
    let path = env
        .get_string(&path)
        .map_err(|_| "Could not decode the Android app files directory path.".to_string())?
        .to_string_lossy()
        .into_owned();
    Ok(PathBuf::from(path))
}
