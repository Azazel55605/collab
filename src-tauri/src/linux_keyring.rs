//! Non-interactive access to the same Secret Service entries as keyring-rs.
//! Its normal get/set operations can call Unlock and wait for a desktop dialog.
//! A timer or a vault-cache read must be able to defer until the user unlocks it.

use dbus::arg::{PropMap, RefArg, Variant};
use dbus::blocking::{stdintf::org_freedesktop_dbus::Properties, Connection, Proxy};
use dbus::Path;
use std::{collections::HashMap, time::Duration};

const BUS: &str = "org.freedesktop.secrets";
const ROOT: &str = "/org/freedesktop/secrets";
const SERVICE: &str = "org.freedesktop.Secret.Service";
const COLLECTION: &str = "org.freedesktop.Secret.Collection";
const ITEM: &str = "org.freedesktop.Secret.Item";
pub(crate) const LOCKED: &str = "Unlock your Linux system keyring to continue.";
const UNAVAILABLE: &str = "The Linux Secret Service is unavailable. Check that your desktop keyring is running and has a default collection.";

fn failure(error: dbus::Error) -> String {
    match error.name() {
        Some("org.freedesktop.Secret.Error.IsLocked") => LOCKED,
        _ => UNAVAILABLE,
    }
    .into()
}

fn proxy<'a>(bus: &'a Connection, path: &Path<'static>) -> Proxy<'a, &'a Connection> {
    bus.with_proxy(BUS, path.clone(), Duration::from_secs(5))
}

enum Location {
    Item(Path<'static>),
    EmptyCollection(Path<'static>),
}

pub(crate) struct UnlockedCredential<'a> {
    bus: Connection,
    location: Location,
    service: &'a str,
    account: &'a str,
}

impl<'a> UnlockedCredential<'a> {
    pub(crate) fn open(service: &'a str, account: &'a str) -> Result<Self, String> {
        let bus = Connection::new_session().map_err(failure)?;
        let root = proxy(&bus, &ROOT.into());
        let attrs = HashMap::from([
            ("service", service),
            ("username", account),
            ("target", "default"),
        ]);
        let (mut unlocked, locked): (Vec<Path>, Vec<Path>) = root
            .method_call(SERVICE, "SearchItems", (attrs,))
            .map_err(failure)?;
        let ambiguous = "Multiple system keyring entries match this Collab credential.";
        if unlocked.len() + locked.len() > 1 {
            return Err(ambiguous.into());
        }
        if !locked.is_empty() {
            return Err(LOCKED.into());
        }
        let location = if let Some(item) = unlocked.pop() {
            Location::Item(item)
        } else {
            // Older entries can omit "target". Like keyring-rs, search for
            // those only in the default collection. Some providers conceal
            // attributes while locked, so an empty search cannot prove absence.
            let (path,): (Path,) = root
                .method_call(SERVICE, "ReadAlias", ("default",))
                .map_err(failure)?;
            if &*path == "/" {
                return Err(UNAVAILABLE.into());
            }
            let collection = proxy(&bus, &path);
            if collection
                .get::<bool>(COLLECTION, "Locked")
                .map_err(failure)?
            {
                return Err(LOCKED.into());
            }
            let legacy = HashMap::from([("service", service), ("username", account)]);
            let (items,): (Vec<Path>,) = collection
                .method_call(COLLECTION, "SearchItems", (legacy,))
                .map_err(failure)?;
            match items.as_slice() {
                [] => Location::EmptyCollection(path),
                [item] => Location::Item(item.clone()),
                _ => return Err(ambiguous.into()),
            }
        };
        Ok(Self {
            bus,
            location,
            service,
            account,
        })
    }

    // The same standard Secret Service session algorithm as the supported
    // keyring-rs sync backend in this build. Dropping this private connection
    // releases its session and any unaccepted prompt.
    fn session(&self) -> Result<Path<'static>, String> {
        let (_, session): (Variant<Box<dyn RefArg>>, Path) = proxy(&self.bus, &ROOT.into())
            .method_call(SERVICE, "OpenSession", ("plain", Variant("")))
            .map_err(failure)?;
        Ok(session)
    }

    pub(crate) fn read(&self) -> Result<Option<String>, String> {
        let Location::Item(item) = &self.location else {
            return Ok(None);
        };
        type Secret = (Path<'static>, Vec<u8>, Vec<u8>, String);
        let (secret,): (Secret,) = proxy(&self.bus, item)
            .method_call(ITEM, "GetSecret", (self.session()?,))
            .map_err(failure)?;
        String::from_utf8(secret.2)
            .map(Some)
            .map_err(|_| "The stored credential is invalid.".into())
    }

    pub(crate) fn write(&self, value: &str) -> Result<(), String> {
        let secret = (
            self.session()?,
            Vec::<u8>::new(),
            value.as_bytes(),
            "text/plain",
        );
        match &self.location {
            Location::Item(item) => proxy(&self.bus, item)
                .method_call(ITEM, "SetSecret", (secret,))
                .map_err(failure),
            Location::EmptyCollection(path) => {
                let attrs = HashMap::from([
                    ("service".to_owned(), self.service.to_owned()),
                    ("username".to_owned(), self.account.to_owned()),
                    ("target".to_owned(), "default".to_owned()),
                    ("application".to_owned(), "rust-keyring".to_owned()),
                ]);
                let mut props = PropMap::new();
                props.insert(format!("{ITEM}.Attributes"), Variant(Box::new(attrs)));
                props.insert(
                    format!("{ITEM}.Label"),
                    Variant(Box::new(format!("{}@{}", self.account, self.service))),
                );
                let (item, _prompt): (Path, Path) = proxy(&self.bus, path)
                    .method_call(COLLECTION, "CreateItem", (props, secret, false))
                    .map_err(failure)?;
                if &*item == "/" {
                    return Err(LOCKED.into());
                }
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests;
