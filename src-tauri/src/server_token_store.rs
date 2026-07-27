#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
const KEYRING_SERVICE: &str = "collab-server";

// Refresh-token storage is per-platform.
//
// Linux defaults to the kernel keyutils keyring: silent (no D-Bus prompt), never
// written to disk, and cleared on reboot, which reconnects the "re-login after a
// reboot" tradeoff. When the user opts into cross-reboot persistence we use the
// D-Bus Secret Service instead, which is durable but may prompt to unlock the
// keyring. `persist_across_reboots` selects the Linux backend; on Windows/macOS
// the native OS keystore (Credential Manager / Keychain) is always used and the
// flag is ignored, because those stores are already silent and durable.

#[cfg(target_os = "linux")]
fn keyutils_entry(server_url: &str) -> Result<keyring::Entry, String> {
    let cred =
        keyring::keyutils::KeyutilsCredential::new_with_target(None, KEYRING_SERVICE, server_url)
            .map_err(|_| "The session keyring is unavailable.".to_string())?;
    Ok(keyring::Entry::new_with_credential(Box::new(cred)))
}

#[cfg(target_os = "linux")]
fn secret_service_entry(server_url: &str) -> Result<keyring::Entry, String> {
    // `new_with_target(None, ..)` uses the "default" target, matching the
    // attributes written by earlier versions (keyring's default builder), so
    // tokens saved before this change are still found on upgrade.
    let cred =
        keyring::secret_service::SsCredential::new_with_target(None, KEYRING_SERVICE, server_url)
            .map_err(|_| "The system keyring (Secret Service) is unavailable.".to_string())?;
    Ok(keyring::Entry::new_with_credential(Box::new(cred)))
}

#[cfg(target_os = "linux")]
pub fn store_refresh_token(
    server_url: &str,
    refresh_token: &str,
    persist_across_reboots: bool,
) -> Result<(), String> {
    if persist_across_reboots {
        secret_service_entry(server_url)?
            .set_password(refresh_token)
            .map_err(|_| "Could not save the server session.".to_string())?;
        // Deleting from keyutils is silent, so clear any stale silent-store copy.
        if let Ok(entry) = keyutils_entry(server_url) {
            let _ = entry.delete_credential();
        }
    } else {
        keyutils_entry(server_url)?
            .set_password(refresh_token)
            .map_err(|_| "Could not save the server session.".to_string())?;
        // Intentionally do NOT touch the Secret Service on this default path:
        // reading or deleting from a locked collection could trigger the unlock
        // prompt this silent path exists to avoid. A stale Secret Service token
        // from a previous opt-in is harmless: silent reconnects ignore it, and
        // explicit disconnect clears both backends.
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn read_refresh_token(server_url: &str, persist_across_reboots: bool) -> Option<String> {
    let keyutils_token = keyutils_entry(server_url)
        .ok()
        .and_then(|entry| entry.get_password().ok());
    if keyutils_token.is_some() || !persist_across_reboots {
        return keyutils_token;
    }
    // Secret Service is durable but can prompt to unlock the desktop keyring, so
    // only read it when the saved server preference explicitly asked for
    // cross-reboot persistence.
    secret_service_entry(server_url)
        .ok()
        .and_then(|entry| entry.get_password().ok())
}

#[cfg(target_os = "linux")]
pub fn delete_refresh_token(server_url: &str) {
    if let Ok(entry) = keyutils_entry(server_url) {
        let _ = entry.delete_credential();
    }
    if let Ok(entry) = secret_service_entry(server_url) {
        let _ = entry.delete_credential();
    }
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn native_entry(server_url: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, server_url)
        .map_err(|_| "The operating system credential store is unavailable.".into())
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
pub fn store_refresh_token(
    server_url: &str,
    refresh_token: &str,
    _persist_across_reboots: bool,
) -> Result<(), String> {
    native_entry(server_url)?
        .set_password(refresh_token)
        .map_err(|_| {
            "Could not save the server session in the operating system credential store.".into()
        })
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
pub fn read_refresh_token(server_url: &str, _persist_across_reboots: bool) -> Option<String> {
    native_entry(server_url)
        .ok()
        .and_then(|entry| entry.get_password().ok())
}

#[cfg(any(target_os = "windows", target_os = "macos"))]
pub fn delete_refresh_token(server_url: &str) {
    if let Ok(entry) = native_entry(server_url) {
        let _ = entry.delete_credential();
    }
}

#[cfg(target_os = "android")]
const TOKEN_STORE_CLASS: &str = "com.azazel.collab.companion.CollabTokenStore";

#[cfg(target_os = "android")]
pub fn store_refresh_token(
    server_url: &str,
    refresh_token: &str,
    _persist_across_reboots: bool,
) -> Result<(), String> {
    // The Kotlin store returns an error message string on failure, or null on success.
    match crate::android_jni::call_static_string(
        TOKEN_STORE_CLASS,
        "storeRefreshToken",
        &[server_url, refresh_token],
    )? {
        Some(error) => Err(format!(
            "Could not save the server session in Android Keystore: {error}"
        )),
        None => Ok(()),
    }
}

#[cfg(target_os = "android")]
pub fn read_refresh_token(server_url: &str, _persist_across_reboots: bool) -> Option<String> {
    crate::android_jni::call_static_string(TOKEN_STORE_CLASS, "readRefreshToken", &[server_url])
        .ok()
        .flatten()
}

#[cfg(target_os = "android")]
pub fn delete_refresh_token(server_url: &str) {
    let _ = crate::android_jni::call_static_string(
        TOKEN_STORE_CLASS,
        "deleteRefreshToken",
        &[server_url],
    );
}

#[cfg(target_os = "ios")]
pub fn store_refresh_token(
    _server_url: &str,
    _refresh_token: &str,
    _persist_across_reboots: bool,
) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "ios")]
pub fn read_refresh_token(_server_url: &str, _persist_across_reboots: bool) -> Option<String> {
    None
}

#[cfg(target_os = "ios")]
pub fn delete_refresh_token(_server_url: &str) {}
