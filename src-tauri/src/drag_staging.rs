//! Private drag leases: active transfers are locked; released/crashed leases
//! are scavenged after a grace period without following temp-directory symlinks.
use parking_lot::Mutex;
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    sync::LazyLock,
    time::{Duration, SystemTime},
};
struct Lease {
    _directory: tempfile::TempDir,
    _lock: Option<File>,
    bytes: usize,
    released: Option<std::time::Instant>,
}
static LEASES: LazyLock<Mutex<HashMap<PathBuf, Lease>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const PREFIX: &str = "collab-drag-v2-";
const GRACE: Duration = Duration::from_secs(24 * 60 * 60);
const BUDGET: usize = 256 * 1024 * 1024;

pub(crate) fn stage(name: &str, bytes: &[u8]) -> Result<String, String> {
    scavenge();
    let mut leases = LEASES.lock();
    leases.retain(|_, lease| lease.released.is_none_or(|at| at.elapsed() < GRACE));
    while leases.len() >= 32
        || leases
            .values()
            .map(|l| l.bytes)
            .sum::<usize>()
            .saturating_add(bytes.len())
            > BUDGET
    {
        let oldest = leases
            .iter()
            .filter(|(_, l)| {
                l.released
                    .is_some_and(|at| at.elapsed() >= Duration::from_secs(60))
            })
            .min_by_key(|(_, l)| l.released)
            .map(|(p, _)| p.clone());
        if let Some(path) = oldest {
            leases.remove(&path);
        } else {
            break;
        }
    }
    if leases.len() >= 32
        || leases
            .values()
            .map(|l| l.bytes)
            .sum::<usize>()
            .saturating_add(bytes.len())
            > BUDGET
    {
        return Err("Native drag staging is full; finish an existing transfer".into());
    }
    let directory = tempfile::Builder::new()
        .prefix(PREFIX)
        .tempdir()
        .map_err(|e| e.to_string())?;
    let lock = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(directory.path().join("lease.lock"))
        .map_err(|e| e.to_string())?;
    lock.try_lock().map_err(|e| e.to_string())?;
    let safe = Path::new(name)
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty() && *s != "lease.lock")
        .unwrap_or("file");
    let path = directory.path().join(safe);
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    leases.insert(
        path.clone(),
        Lease {
            _directory: directory,
            _lock: Some(lock),
            bytes: bytes.len(),
            released: None,
        },
    );
    Ok(path.to_string_lossy().into_owned())
}
pub(crate) fn release(path: &str) {
    if let Some(lease) = LEASES.lock().get_mut(Path::new(path)) {
        lease.released = Some(std::time::Instant::now());
        lease._lock = None;
    }
}
pub(crate) fn scavenge() {
    LEASES
        .lock()
        .retain(|_, l| l.released.is_none_or(|at| at.elapsed() < GRACE));
    scavenge_in(&std::env::temp_dir(), GRACE);
}
fn scavenge_in(root: &Path, grace: Duration) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    // Bound directory traversal, including unrelated entries.
    for entry in entries.take(4096).flatten() {
        if !entry.file_name().to_string_lossy().starts_with(PREFIX) {
            continue;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if !kind.is_dir() || kind.is_symlink() {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if meta
            .modified()
            .ok()
            .and_then(|t| SystemTime::now().duration_since(t).ok())
            .is_none_or(|age| age < grace)
        {
            continue;
        }
        let marker = entry.path().join("lease.lock");
        let Ok(marker_meta) = std::fs::symlink_metadata(&marker) else {
            continue;
        };
        if !marker_meta.is_file() || marker_meta.file_type().is_symlink() {
            continue;
        }
        let Ok(lock) = OpenOptions::new().write(true).open(marker) else {
            continue;
        };
        if lock.try_lock().is_ok() {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gc_skips_locked_active_leases_and_collects_released_leases() {
        let root = tempfile::tempdir().unwrap();
        let dir = tempfile::Builder::new()
            .prefix(PREFIX)
            .tempdir_in(root.path())
            .unwrap();
        let path = dir.keep();
        let lock = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(path.join("lease.lock"))
            .unwrap();
        lock.lock().unwrap();
        scavenge_in(root.path(), Duration::ZERO);
        assert!(path.exists());
        drop(lock);
        scavenge_in(root.path(), Duration::ZERO);
        assert!(!path.exists());
    }
    #[test]
    fn filenames_stay_in_private_owned_directories() {
        let path = stage("../../secret", b"test").unwrap();
        assert!(Path::new(&path)
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(PREFIX));
        assert_eq!(std::fs::read(&path).unwrap(), b"test");
        let lease = LEASES.lock().remove(Path::new(&path)).unwrap();
        drop(lease);
        assert!(!Path::new(&path).exists());
    }
}
