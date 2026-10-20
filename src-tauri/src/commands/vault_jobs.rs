//! Filesystem/CPU work never runs on the webview IPC thread. Two process-wide
//! slots bound listing, indexing and search, including jobs for retired vaults.
use std::sync::{Arc, OnceLock};

pub async fn run<T: Send + 'static>(
    job: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    static BUDGET: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    let permit = BUDGET
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(2)))
        .clone()
        .acquire_owned()
        .await
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        job()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    #[tokio::test]
    async fn bounds_native_work_across_concurrent_callers() {
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut jobs = Vec::new();
        for _ in 0..12 {
            let active = active.clone();
            let peak = peak.clone();
            jobs.push(tokio::spawn(run(move || {
                let count = active.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(count, Ordering::SeqCst);
                std::thread::sleep(std::time::Duration::from_millis(5));
                active.fetch_sub(1, Ordering::SeqCst);
                Ok(())
            })));
        }
        for job in jobs {
            job.await.unwrap().unwrap();
        }
        assert!(peak.load(Ordering::SeqCst) <= 2);
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }
}
