use std::fs;
use std::path::{Path, PathBuf};

use tempfile::TempDir;

pub struct TempVault {
    temp_dir: TempDir,
}

impl TempVault {
    pub fn new() -> Result<Self, String> {
        let temp_dir = tempfile::tempdir().map_err(|e| e.to_string())?;
        let vault = Self { temp_dir };
        vault.ensure_collab_dirs()?;
        Ok(vault)
    }

    pub fn path(&self) -> &Path {
        self.temp_dir.path()
    }

    pub fn path_string(&self) -> String {
        self.path().to_string_lossy().to_string()
    }

    pub fn resolve(&self, relative_path: &str) -> PathBuf {
        self.path().join(relative_path)
    }

    pub fn write_text(&self, relative_path: &str, content: &str) -> Result<(), String> {
        let full_path = self.resolve(relative_path);
        if let Some(parent) = full_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(full_path, content).map_err(|e| e.to_string())
    }

    pub fn write_bytes(&self, relative_path: &str, bytes: &[u8]) -> Result<(), String> {
        let full_path = self.resolve(relative_path);
        if let Some(parent) = full_path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(full_path, bytes).map_err(|e| e.to_string())
    }

    pub fn read_text(&self, relative_path: &str) -> Result<String, String> {
        fs::read_to_string(self.resolve(relative_path)).map_err(|e| e.to_string())
    }

    pub fn read_bytes(&self, relative_path: &str) -> Result<Vec<u8>, String> {
        fs::read(self.resolve(relative_path)).map_err(|e| e.to_string())
    }

    pub fn exists(&self, relative_path: &str) -> bool {
        self.resolve(relative_path).exists()
    }

    pub fn create_dir(&self, relative_path: &str) -> Result<(), String> {
        fs::create_dir_all(self.resolve(relative_path)).map_err(|e| e.to_string())
    }

    pub fn ensure_collab_dirs(&self) -> Result<(), String> {
        self.create_dir(".collab")?;
        self.create_dir(".collab/presence")?;
        self.create_dir(".collab/chat")?;
        self.create_dir(".collab/history")?;
        self.create_dir(".collab/templates/kanban")?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::TempVault;

    #[test]
    fn temp_vault_creates_expected_collab_dirs() {
        let vault = TempVault::new().expect("temp vault should be created");

        assert!(vault.exists(".collab"));
        assert!(vault.exists(".collab/presence"));
        assert!(vault.exists(".collab/chat"));
        assert!(vault.exists(".collab/history"));
        assert!(vault.exists(".collab/templates/kanban"));
    }

    #[test]
    fn temp_vault_reads_and_writes_text_files() {
        let vault = TempVault::new().expect("temp vault should be created");

        vault
            .write_text("Notes/Test.md", "# hello")
            .expect("text should be written");

        let content = vault
            .read_text("Notes/Test.md")
            .expect("text should be readable");

        assert_eq!(content, "# hello");
    }
}
