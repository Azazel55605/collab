use collab_database::ContractError as E;
const SERVICE: &str = "collab-database-v1";
fn entry(owner: &str, id: &str) -> Result<keyring::Entry, E> {
    let account = format!("{owner}:{id}");
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("FLATPAK_ID").is_some() {
            return Err(E::Unsupported);
        }
        let credential =
            keyring::secret_service::SsCredential::new_with_target(None, SERVICE, &account)
                .map_err(|_| E::CredentialStoreUnavailable)?;
        Ok(keyring::Entry::new_with_credential(Box::new(credential)))
    }
    #[cfg(not(target_os = "linux"))]
    {
        keyring::Entry::new(SERVICE, &account).map_err(|_| E::CredentialStoreUnavailable)
    }
}
pub fn read(owner: &str, id: &str) -> Result<String, E> {
    entry(owner, id)?
        .get_password()
        .map_err(|_| E::CredentialStoreUnavailable)
}
pub fn save(owner: &str, id: &str, password: &str) -> Result<(), E> {
    entry(owner, id)?
        .set_password(password)
        .map_err(|_| E::CredentialStoreUnavailable)
}
pub fn delete(owner: &str, id: &str) -> Result<(), E> {
    match entry(owner, id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(E::CredentialStoreUnavailable),
    }
}
