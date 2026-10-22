//! Process-local coordination for native local-file mutations.
//!
//! A namespace operation reserves its vault root before reading/checking paths;
//! leaf writes (including absolute exports) conflict with that reservation.
//! Acquire every outer scope together. Nested helpers may only narrow scopes.
//! Guards are thread-bound and must never span an await or a network request.
use parking_lot::{Condvar, Mutex};
use std::marker::PhantomData;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::LazyLock;
use std::thread::ThreadId;

struct Reservation {
    id: u64,
    owner: ThreadId,
    paths: Vec<PathBuf>,
}

#[derive(Default)]
struct Registry {
    next_id: u64,
    active: Vec<Reservation>,
    waiting: Vec<Reservation>,
}

static REGISTRY: LazyLock<(Mutex<Registry>, Condvar)> =
    LazyLock::new(|| (Mutex::new(Registry::default()), Condvar::new()));

pub(crate) struct MutationGuard {
    _trace: crate::performance::Span,
    id: u64,
    _thread_bound: PhantomData<Rc<()>>,
}

impl Drop for MutationGuard {
    fn drop(&mut self) {
        let (mutex, changed) = &*REGISTRY;
        mutex.lock().active.retain(|entry| entry.id != self.id);
        changed.notify_all();
    }
}

/// Resolve aliases without creating missing parents before holding the guard.
fn identity(path: &Path) -> Result<PathBuf, String> {
    let absolute = std::path::absolute(path).map_err(|error| error.to_string())?;
    let mut ancestor = absolute.as_path();
    let mut missing = Vec::new();
    loop {
        match ancestor.canonicalize() {
            Ok(mut canonical) => {
                for part in missing.into_iter().rev() {
                    canonical.push(part);
                }
                return Ok(canonical);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(
                    ancestor
                        .file_name()
                        .ok_or("Invalid mutation path")?
                        .to_os_string(),
                );
                ancestor = ancestor.parent().ok_or("Missing mutation parent")?;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
}

pub(crate) fn lock_path(path: &Path) -> Result<MutationGuard, String> {
    lock_paths(&[path])
}

pub(crate) fn lock_paths(paths: &[&Path]) -> Result<MutationGuard, String> {
    let _wait = crate::performance::span("storage.lock.wait");
    let paths = paths
        .iter()
        .map(|path| identity(path))
        .collect::<Result<Vec<_>, _>>()?;
    let owner = std::thread::current().id();
    let (mutex, changed) = &*REGISTRY;
    let mut registry = mutex.lock();
    let owned = registry
        .active
        .iter()
        .filter(|entry| entry.owner == owner)
        .collect::<Vec<_>>();
    // Expanding a nested reservation could deadlock two writers holding disjoint
    // children and both trying to acquire their parent. Fail instead of hanging.
    if !owned.is_empty()
        && paths.iter().any(|path| {
            !owned
                .iter()
                .any(|entry| entry.paths.iter().any(|parent| path.starts_with(parent)))
        })
    {
        return Err("Acquire the enclosing mutation scopes before modifying child paths".into());
    }
    let reentrant = !owned.is_empty();
    drop(owned);
    let id = registry.next_id;
    registry.next_id = registry.next_id.wrapping_add(1);
    if !reentrant {
        registry.waiting.push(Reservation {
            id,
            owner,
            paths: paths.clone(),
        });
    }
    let overlaps = |entry: &Reservation| {
        entry.paths.iter().any(|active| {
            paths
                .iter()
                .any(|path| path.starts_with(active) || active.starts_with(path))
        })
    };
    while registry
        .active
        .iter()
        .any(|entry| entry.owner != owner && overlaps(entry))
        || (!reentrant
            && registry
                .waiting
                .iter()
                .take_while(|entry| entry.id != id)
                .any(&overlaps))
    {
        changed.wait(&mut registry);
    }
    registry.waiting.retain(|entry| entry.id != id);
    registry.active.push(Reservation { id, owner, paths });
    Ok(MutationGuard {
        _trace: crate::performance::span("storage.lock.hold"),
        id,
        _thread_bound: PhantomData,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn namespace_blocks_leaf_writes_but_not_other_vaults() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let guard = lock_path(first.path()).unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        std::thread::scope(|scope| {
            scope.spawn(|| {
                started_tx.send(()).unwrap();
                let _leaf = lock_path(&first.path().join("missing/note.md")).unwrap();
                done_tx.send(()).unwrap();
            });
            started_rx.recv().unwrap();
            assert!(done_rx.recv_timeout(Duration::from_millis(30)).is_err());
            scope
                .spawn(|| {
                    let _other = lock_path(second.path()).unwrap();
                })
                .join()
                .unwrap();
            drop(guard);
            done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        });
    }

    #[test]
    fn nested_helpers_are_reentrant_and_scope_expansion_fails() {
        let root = tempfile::tempdir().unwrap();
        let _root = lock_path(root.path()).unwrap();
        let child = root.path().join("note.md");
        let _child = lock_path(&child).unwrap();
        assert!(lock_path(root.path().parent().unwrap()).is_err());
    }

    #[test]
    fn aliases_share_a_scope_and_panics_release_reservations() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("folder")).unwrap();
        assert_eq!(
            identity(root.path()).unwrap(),
            identity(&root.path().join("folder/..")).unwrap()
        );
        #[cfg(unix)]
        {
            let aliases = tempfile::tempdir().unwrap();
            let alias = aliases.path().join("vault-alias");
            std::os::unix::fs::symlink(root.path(), &alias).unwrap();
            assert_eq!(identity(root.path()).unwrap(), identity(&alias).unwrap());
            assert_eq!(
                identity(&root.path().join("missing/note.md")).unwrap(),
                identity(&alias.join("missing/note.md")).unwrap()
            );
        }
        let _ = std::panic::catch_unwind(|| {
            let _guard = lock_path(root.path()).unwrap();
            panic!("simulated failed mutation");
        });
        // A different thread would hang if unwinding leaked the reservation.
        std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    let _guard = lock_path(root.path()).unwrap();
                })
                .join()
                .unwrap();
        });
    }
}
