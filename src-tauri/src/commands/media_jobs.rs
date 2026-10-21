//! Bounded cancellable native work, including cancellation arriving before registration.
use parking_lot::Mutex;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock,
    },
    time::{Duration, Instant},
};
struct Record {
    flag: Arc<AtomicBool>,
    created: Instant,
    started: bool,
}
static JOBS: LazyLock<Mutex<HashMap<String, Record>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
#[derive(Clone)]
pub struct MediaJob {
    id: String,
    cancelled: Arc<AtomicBool>,
}
impl MediaJob {
    pub fn start(id: String) -> Result<Self, String> {
        if id.len() > 128 || id.is_empty() {
            return Err("Invalid media job identifier".into());
        }
        let mut jobs = JOBS.lock();
        jobs.retain(|_, job| job.started || job.created.elapsed() < Duration::from_secs(60));
        if jobs.len() >= 256 && !jobs.contains_key(&id) {
            return Err("Native media queue is full".into());
        }
        let entry = jobs.entry(id.clone()).or_insert_with(|| Record {
            flag: Arc::new(AtomicBool::new(false)),
            created: Instant::now(),
            started: false,
        });
        if entry.started {
            return Err("Media job is already registered".into());
        }
        entry.started = true;
        Ok(Self {
            id,
            cancelled: entry.flag.clone(),
        })
    }
    pub fn check(&self) -> Result<(), String> {
        if self.cancelled.load(Ordering::Relaxed) {
            Err("Media job cancelled".into())
        } else {
            Ok(())
        }
    }
    pub async fn wait<T>(&self, future: impl std::future::Future<Output = T>) -> Result<T, String> {
        tokio::pin!(future);
        loop {
            self.check()?;
            tokio::select! {value=&mut future=>return Ok(value),_=tokio::time::sleep(Duration::from_millis(25))=>{}}
        }
    }
}
impl Drop for MediaJob {
    fn drop(&mut self) {
        if Arc::strong_count(&self.cancelled) <= 2 {
            JOBS.lock().remove(&self.id);
        }
    }
}
#[tauri::command]
pub fn cancel_media_job(request_id: String) {
    if request_id.len() > 128 || request_id.is_empty() {
        return;
    }
    let mut jobs = JOBS.lock();
    jobs.retain(|_, job| job.started || job.created.elapsed() < Duration::from_secs(60));
    if let Some(job) = jobs.get(&request_id) {
        job.flag.store(true, Ordering::Relaxed);
    } else if jobs.len() < 256 {
        jobs.insert(
            request_id,
            Record {
                flag: Arc::new(AtomicBool::new(true)),
                created: Instant::now(),
                started: false,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn handles_early_cancellation_and_releases_registration() {
        let id = uuid::Uuid::new_v4().to_string();
        cancel_media_job(id.clone());
        let job = MediaJob::start(id.clone()).unwrap();
        assert!(job.check().is_err());
        drop(job);
        let job = MediaJob::start(id).unwrap();
        assert!(job.check().is_ok());
    }
    #[tokio::test]
    async fn cancellation_drops_a_pending_native_future() {
        let id = uuid::Uuid::new_v4().to_string();
        let job = MediaJob::start(id.clone()).unwrap();
        let pending = job.wait(std::future::pending::<()>());
        let cancel = async {
            tokio::time::sleep(Duration::from_millis(10)).await;
            cancel_media_job(id);
        };
        let (result, _) = tokio::join!(pending, cancel);
        assert!(result.unwrap_err().contains("cancelled"));
    }
}
