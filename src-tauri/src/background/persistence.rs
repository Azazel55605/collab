use super::models::{
    BackgroundJobRecord, BackgroundJobStatus, BackgroundLedger, BackgroundRegistry,
    BackgroundServerRegistration, BackgroundSettings, BACKGROUND_LEDGER_SCHEMA_VERSION,
    BACKGROUND_REGISTRY_SCHEMA_VERSION, BACKGROUND_SETTINGS_SCHEMA_VERSION,
};
use chrono::{Duration, Utc};
use parking_lot::Mutex;
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::path::PathBuf;

const LEDGER_FILE: &str = "background-jobs.json";
const REGISTRY_FILE: &str = "background-servers.json";
const SETTINGS_FILE: &str = "background-settings.json";
const MAX_LEDGER_JOBS: usize = 200;
const COMPLETED_JOB_RETENTION_DAYS: i64 = 30;

pub(crate) struct BackgroundPersistence {
    root_override: Option<PathBuf>,
    io_lock: Mutex<()>,
}

impl BackgroundPersistence {
    pub fn new() -> Self {
        Self {
            root_override: None,
            io_lock: Mutex::new(()),
        }
    }

    #[cfg(test)]
    pub fn at(root: PathBuf) -> Self {
        Self {
            root_override: Some(root),
            io_lock: Mutex::new(()),
        }
    }

    pub fn root(&self) -> Result<PathBuf, String> {
        match &self.root_override {
            Some(root) => {
                std::fs::create_dir_all(root).map_err(|error| error.to_string())?;
                Ok(root.clone())
            }
            None => crate::commands::app_config_dir(),
        }
    }

    fn read_json<T: DeserializeOwned + Default>(&self, file_name: &str) -> Result<T, String> {
        let path = self.root()?.join(file_name);
        match std::fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|error| format!("Could not decode {file_name}: {error}")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(T::default()),
            Err(error) => Err(format!("Could not read {file_name}: {error}")),
        }
    }

    fn write_json<T: Serialize>(&self, file_name: &str, value: &T) -> Result<(), String> {
        let root = self.root()?;
        let path = root.join(file_name);
        let temporary = root.join(format!("{file_name}.tmp"));
        let bytes = serde_json::to_vec_pretty(value)
            .map_err(|error| format!("Could not encode {file_name}: {error}"))?;
        std::fs::write(&temporary, bytes)
            .map_err(|error| format!("Could not write {file_name}: {error}"))?;
        #[cfg(target_os = "windows")]
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|error| format!("Could not replace {file_name}: {error}"))?;
        }
        std::fs::rename(&temporary, &path)
            .map_err(|error| format!("Could not replace {file_name}: {error}"))
    }

    pub fn list_jobs(&self, limit: usize) -> Result<Vec<BackgroundJobRecord>, String> {
        let _guard = self.io_lock.lock();
        let ledger = self.load_ledger()?;
        let limit = limit.clamp(1, MAX_LEDGER_JOBS);
        Ok(ledger.jobs.into_iter().rev().take(limit).collect())
    }

    pub fn job(&self, id: &str) -> Result<Option<BackgroundJobRecord>, String> {
        let _guard = self.io_lock.lock();
        let ledger = self.load_ledger()?;
        Ok(ledger.jobs.into_iter().find(|job| job.id == id))
    }

    pub fn insert_job(&self, job: BackgroundJobRecord) -> Result<(), String> {
        let _guard = self.io_lock.lock();
        let mut ledger = self.load_ledger()?;
        ledger.jobs.push(job);
        trim_jobs(&mut ledger.jobs);
        self.write_json(LEDGER_FILE, &ledger)
    }

    pub fn recover_on_startup(&self) -> Result<(), String> {
        let _guard = self.io_lock.lock();
        let mut ledger = self.load_ledger()?;
        if recover_abandoned_jobs(&mut ledger.jobs) {
            self.write_json(LEDGER_FILE, &ledger)?;
        }
        Ok(())
    }

    pub fn update_job(
        &self,
        id: &str,
        update: impl FnOnce(&mut BackgroundJobRecord),
    ) -> Result<BackgroundJobRecord, String> {
        let _guard = self.io_lock.lock();
        let mut ledger = self.load_ledger()?;
        let job = ledger
            .jobs
            .iter_mut()
            .find(|job| job.id == id)
            .ok_or_else(|| "The background job no longer exists.".to_string())?;
        update(job);
        let result = job.clone();
        trim_jobs(&mut ledger.jobs);
        self.write_json(LEDGER_FILE, &ledger)?;
        Ok(result)
    }

    pub fn list_servers(&self) -> Result<Vec<BackgroundServerRegistration>, String> {
        let _guard = self.io_lock.lock();
        Ok(self.load_registry()?.servers)
    }

    pub fn replace_servers(
        &self,
        mut servers: Vec<BackgroundServerRegistration>,
    ) -> Result<Vec<BackgroundServerRegistration>, String> {
        let _guard = self.io_lock.lock();
        let existing = self.load_registry()?.servers;
        for server in &mut servers {
            if let Some(previous) = existing
                .iter()
                .find(|entry| entry.server_url == server.server_url)
            {
                server
                    .profile_ids
                    .extend(previous.profile_ids.iter().cloned());
                server.profile_ids.sort();
                server.profile_ids.dedup();
            }
        }
        normalize_servers(&mut servers);
        let registry = BackgroundRegistry {
            schema_version: BACKGROUND_REGISTRY_SCHEMA_VERSION,
            servers: servers.clone(),
        };
        self.write_json(REGISTRY_FILE, &registry)?;
        Ok(servers)
    }

    pub fn upsert_server(
        &self,
        mut server: BackgroundServerRegistration,
    ) -> Result<BackgroundServerRegistration, String> {
        let _guard = self.io_lock.lock();
        let mut registry = self.load_registry()?;
        if let Some(existing) = registry
            .servers
            .iter()
            .find(|entry| entry.server_url == server.server_url)
        {
            server
                .profile_ids
                .extend(existing.profile_ids.iter().cloned());
            server.profile_ids.sort();
            server.profile_ids.dedup();
        }
        registry
            .servers
            .retain(|entry| entry.server_url != server.server_url);
        registry.servers.push(server.clone());
        normalize_servers(&mut registry.servers);
        self.write_json(REGISTRY_FILE, &registry)?;
        Ok(server)
    }

    pub fn remove_server(&self, server_url: &str) -> Result<(), String> {
        let _guard = self.io_lock.lock();
        let mut registry = self.load_registry()?;
        registry
            .servers
            .retain(|entry| entry.server_url != server_url);
        self.write_json(REGISTRY_FILE, &registry)
    }

    pub fn settings(&self) -> Result<BackgroundSettings, String> {
        let _guard = self.io_lock.lock();
        let settings: BackgroundSettings = self.read_json(SETTINGS_FILE)?;
        if settings.schema_version != BACKGROUND_SETTINGS_SCHEMA_VERSION {
            return Err("The background settings use an unsupported schema.".to_string());
        }
        Ok(settings)
    }

    pub fn save_settings(
        &self,
        settings: BackgroundSettings,
    ) -> Result<BackgroundSettings, String> {
        if settings.schema_version != BACKGROUND_SETTINGS_SCHEMA_VERSION {
            return Err("The background settings use an unsupported schema.".to_string());
        }
        let _guard = self.io_lock.lock();
        self.write_json(SETTINGS_FILE, &settings)?;
        Ok(settings)
    }

    fn load_ledger(&self) -> Result<BackgroundLedger, String> {
        let ledger: BackgroundLedger = self.read_json(LEDGER_FILE)?;
        if ledger.schema_version != BACKGROUND_LEDGER_SCHEMA_VERSION {
            return Err("The background job ledger uses an unsupported schema.".to_string());
        }
        Ok(ledger)
    }

    fn load_registry(&self) -> Result<BackgroundRegistry, String> {
        let registry: BackgroundRegistry = self.read_json(REGISTRY_FILE)?;
        if registry.schema_version != BACKGROUND_REGISTRY_SCHEMA_VERSION {
            return Err("The background server registry uses an unsupported schema.".to_string());
        }
        Ok(registry)
    }
}

fn recover_abandoned_jobs(jobs: &mut [BackgroundJobRecord]) -> bool {
    let mut changed = false;
    for job in jobs {
        if matches!(
            job.status,
            BackgroundJobStatus::Queued | BackgroundJobStatus::Running
        ) {
            job.status = BackgroundJobStatus::Deferred;
            job.finished_at = Some(Utc::now().to_rfc3339());
            job.error_category = Some("interrupted".to_string());
            job.error_message =
                Some("The application stopped before this background job completed.".to_string());
            job.retryable = true;
            changed = true;
        }
    }
    changed
}

fn trim_jobs(jobs: &mut Vec<BackgroundJobRecord>) {
    let cutoff = Utc::now() - Duration::days(COMPLETED_JOB_RETENTION_DAYS);
    jobs.retain(|job| {
        !job.status.is_terminal()
            || job
                .finished_at
                .as_deref()
                .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
                .is_none_or(|finished| finished >= cutoff)
    });
    if jobs.len() > MAX_LEDGER_JOBS {
        jobs.drain(0..jobs.len() - MAX_LEDGER_JOBS);
    }
}

fn normalize_servers(servers: &mut Vec<BackgroundServerRegistration>) {
    servers.sort_by(|left, right| left.server_url.cmp(&right.server_url));
    servers.dedup_by(|left, right| left.server_url == right.server_url);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::background::{BackgroundJobKind, BackgroundJobProgress, BackgroundJobTrigger};

    fn completed_job(id: &str, finished_at: String) -> BackgroundJobRecord {
        BackgroundJobRecord {
            id: id.to_string(),
            idempotency_key: id.to_string(),
            kind: BackgroundJobKind::Maintenance,
            server_url: None,
            profile_id: None,
            vault_id: None,
            trigger: BackgroundJobTrigger::Periodic,
            attempt: 1,
            status: BackgroundJobStatus::Succeeded,
            created_at: finished_at.clone(),
            started_at: Some(finished_at.clone()),
            finished_at: Some(finished_at),
            next_retry_at: None,
            progress: BackgroundJobProgress::default(),
            changed: None,
            summary: None,
            error_category: None,
            error_message: None,
            retryable: false,
        }
    }

    #[test]
    fn retention_removes_old_terminal_jobs_but_keeps_active_work() {
        let old = (Utc::now() - Duration::days(COMPLETED_JOB_RETENTION_DAYS + 1)).to_rfc3339();
        let recent = Utc::now().to_rfc3339();
        let mut active = completed_job("active", old.clone());
        active.status = BackgroundJobStatus::Running;
        active.finished_at = None;
        let mut jobs = vec![
            completed_job("old", old),
            completed_job("recent", recent),
            active,
        ];

        trim_jobs(&mut jobs);

        assert!(!jobs.iter().any(|job| job.id == "old"));
        assert!(jobs.iter().any(|job| job.id == "recent"));
        assert!(jobs.iter().any(|job| job.id == "active"));
    }
}
