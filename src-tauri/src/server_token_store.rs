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
            .map_err(|_| "The Linux kernel keyring is unavailable. Select “Keep me signed in across reboots” to use your desktop keyring.".to_string())?;
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
            .map_err(|_| "Could not save the server session in Secret Service. Unlock your desktop keyring and try again.".to_string())?;
        // Deleting from keyutils is silent, so clear any stale silent-store copy.
        if let Ok(entry) = keyutils_entry(server_url) {
            let _ = entry.delete_credential();
        }
    } else {
        keyutils_entry(server_url)?
            .set_password(refresh_token)
            .map_err(|_| "Could not save the server session in the Linux kernel keyring. Select “Keep me signed in across reboots” to use your desktop keyring.".to_string())?;
        // Intentionally do NOT touch the Secret Service on this default path:
        // reading or deleting from a locked collection could trigger the unlock
        // prompt this silent path exists to avoid. A stale Secret Service token
        // from a previous opt-in is harmless: silent reconnects ignore it, and
        // explicit disconnect clears both backends.
    }
    Ok(())
}

#[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
pub(crate) fn read_entry(entry: keyring::Entry) -> Result<Option<String>, String> {
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("Could not read the operating system credential store. Unlock your keyring and try again.".into()),
    }
}

#[cfg(target_os = "linux")]
pub fn read_refresh_token(
    server_url: &str,
    persist_across_reboots: bool,
    interactive: bool,
) -> Result<Option<String>, String> {
    let silent = keyutils_entry(server_url).and_then(read_entry);
    if !persist_across_reboots || matches!(&silent, Ok(Some(_))) {
        // This also recovers a newer same-boot token from versions which could
        // accidentally switch a durable session to keyutils during reconnect.
        return silent;
    }
    durable_entry(server_url, interactive)?.read()
}

#[cfg(target_os = "linux")]
fn durable_entry(
    server_url: &str,
    interactive: bool,
) -> Result<crate::linux_keyring::UnlockedCredential<'_>, String> {
    use crate::linux_keyring::{UnlockedCredential, LOCKED};
    match UnlockedCredential::open(KEYRING_SERVICE, server_url) {
        Err(reason) if reason == LOCKED && interactive => {
            // Explicit restore may unlock the matching item. Check the collection
            // again even if a locked provider concealed the item's attributes.
            read_entry(secret_service_entry(server_url)?)?;
            UnlockedCredential::open(KEYRING_SERVICE, server_url)
        }
        result => result,
    }
}

/// Check the destination before spending a single-use token. A relock during
/// the request is still possible and is handled when saving the response.
pub(crate) fn prepare_rotation(
    _server_url: &str,
    _persistent: bool,
    _interactive: bool,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if _persistent {
        durable_entry(_server_url, _interactive)?;
    }
    Ok(())
}

pub(crate) fn persist_rotation(
    server_url: &str,
    token: &str,
    persistent: bool,
) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if persistent {
        let saved = crate::linux_keyring::UnlockedCredential::open(KEYRING_SERVICE, server_url)
            .and_then(|credential| credential.write(token));
        if let Ok(entry) = keyutils_entry(server_url) {
            if saved.is_ok() {
                let _ = entry.delete_credential();
            } else {
                // A lock or service failure between exchange and persistence:
                // retain the replacement across a same-boot process restart.
                let _ = entry.set_password(token);
            }
        }
        return saved;
    }
    store_refresh_token(server_url, token, persistent)
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
pub fn read_refresh_token(
    server_url: &str,
    _persist_across_reboots: bool,
    _interactive: bool,
) -> Result<Option<String>, String> {
    read_entry(native_entry(server_url)?)
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
pub fn read_refresh_token(
    server_url: &str,
    _persist_across_reboots: bool,
    _interactive: bool,
) -> Result<Option<String>, String> {
    crate::android_jni::call_static_string(TOKEN_STORE_CLASS, "readRefreshToken", &[server_url])
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
pub fn read_refresh_token(
    _server_url: &str,
    _persist_across_reboots: bool,
    _interactive: bool,
) -> Result<Option<String>, String> {
    Ok(None)
}

#[cfg(target_os = "ios")]
pub fn delete_refresh_token(_server_url: &str) {}
