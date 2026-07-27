use super::models::{
    BackgroundJobRecord, BackgroundJobStatus, BackgroundLedger, BackgroundRegistry,
    BackgroundServerRegistration, BACKGROUND_LEDGER_SCHEMA_VERSION,
    BACKGROUND_REGISTRY_SCHEMA_VERSION,
};
use chrono::Utc;
use parking_lot::Mutex;
use serde::de::DeserializeOwned;
use serde::Serialize;
use std::path::PathBuf;

const LEDGER_FILE: &str = "background-jobs.json";
const REGISTRY_FILE: &str = "background-servers.json";
const MAX_LEDGER_JOBS: usize = 200;

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
        server: BackgroundServerRegistration,
    ) -> Result<BackgroundServerRegistration, String> {
        let _guard = self.io_lock.lock();
        let mut registry = self.load_registry()?;
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
    if jobs.len() > MAX_LEDGER_JOBS {
        jobs.drain(0..jobs.len() - MAX_LEDGER_JOBS);
    }
}

fn normalize_servers(servers: &mut Vec<BackgroundServerRegistration>) {
    servers.sort_by(|left, right| left.server_url.cmp(&right.server_url));
    servers.dedup_by(|left, right| left.server_url == right.server_url);
}
