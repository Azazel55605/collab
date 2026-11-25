use super::{decode_replica_key, replica_account, REPLICA_KEYRING_SERVICE};
use crate::{linux_keyring::UnlockedCredential, server_token_store::read_entry};
use base64::Engine as _;
use parking_lot::Mutex;
use std::{collections::HashMap, sync::LazyLock};

// Serialize first use as well as deletion. Concurrent cold opens of the same
// vault must never independently generate different encryption keys.
static KEYS: LazyLock<Mutex<HashMap<String, [u8; 32]>>> = LazyLock::new(Mutex::default);

fn kernel_entry(account: &str) -> Option<keyring::Entry> {
    let credential = keyring::keyutils::KeyutilsCredential::new_with_target(
        None,
        REPLICA_KEYRING_SERVICE,
        account,
    )
    .ok()?;
    Some(keyring::Entry::new_with_credential(Box::new(credential)))
}

pub(crate) fn replica_key(
    server_url: &str,
    vault_id: &str,
    create: bool,
) -> Result<Option<[u8; 32]>, String> {
    let account = replica_account(server_url, vault_id);
    let mut keys = KEYS.lock();
    if let Some(key) = keys.get(&account) {
        return Ok(Some(*key));
    }
    let legacy = || kernel_entry(&account).and_then(|entry| read_entry(entry).ok().flatten());
    let durable = UnlockedCredential::open(REPLICA_KEYRING_SERVICE, &account);
    let (saved, entry) = match durable.and_then(|entry| Ok((entry.read()?, entry))) {
        Ok(found) => found,
        Err(error) => {
            // Existing kernel copies can still open offline edits. Retry the
            // durable lookup later, and never mint a key after a storage error.
            return match legacy() {
                Some(encoded) => decode_replica_key(&encoded).map(Some),
                None => Err(error),
            };
        }
    };
    let key = if let Some(encoded) = saved {
        let key = decode_replica_key(&encoded)?;
        if let Some(mirror) = legacy() {
            if decode_replica_key(&mirror)? != key {
                return Err("The desktop and kernel keyrings contain different offline replica keys. Both keys have been preserved.".into());
            }
        }
        key
    } else if let Some(encoded) = legacy() {
        let key = decode_replica_key(&encoded)?;
        if entry.write(&encoded).is_err() {
            return Ok(Some(key));
        }
        key
    } else if create {
        let key: [u8; 32] = rand::random();
        entry.write(&base64::engine::general_purpose::STANDARD.encode(key))?;
        key
    } else {
        return Ok(None);
    };
    if let Some(entry) = kernel_entry(&account) {
        let _ = entry.set_password(&base64::engine::general_purpose::STANDARD.encode(key));
    }
    keys.insert(account, key);
    Ok(Some(key))
}

pub(super) fn delete_replica_key(server_url: &str, vault_id: &str) {
    let account = replica_account(server_url, vault_id);
    let mut keys = KEYS.lock();
    keys.remove(&account);
    if let Some(entry) = kernel_entry(&account) {
        let _ = entry.delete_credential();
    }
    if let Ok(credential) = keyring::secret_service::SsCredential::new_with_target(
        None,
        REPLICA_KEYRING_SERVICE,
        &account,
    ) {
        let _ = keyring::Entry::new_with_credential(Box::new(credential)).delete_credential();
    }
}
