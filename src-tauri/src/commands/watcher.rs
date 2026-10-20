use crate::state::AppState;
use base64::Engine as _;
use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebounceEventResult};
use std::path::Path;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

fn is_ignored_dir_name(name: &str) -> bool {
    matches!(
        name,
        "node_modules"
            | "target"
            | "dist"
            | "dist-builds"
            | "build"
            | "flatpak-build"
            | "flatpak-repo"
    )
}

fn should_ignore_relative_path(relative: &str) -> bool {
    relative.split('/').any(|segment| {
        !segment.is_empty() && (segment.starts_with('.') || is_ignored_dir_name(segment))
    })
}

fn nearest_visible_relative_parent(relative: &str) -> Option<String> {
    let segments: Vec<_> = relative.split('/').filter(|s| !s.is_empty()).collect();
    // Only known editor staging names warrant a visible-parent reconciliation.
    // Dependency trees, dot metadata and generated output never bubble up.
    let hidden = segments.iter().position(|s| s.starts_with('.'))?;
    if segments[..hidden].iter().any(|s| is_ignored_dir_name(s)) {
        return None;
    }
    let name = segments[hidden];
    if !(name.starts_with(".goutputstream-")
        || name.starts_with(".tmp")
        || name.starts_with(".swp"))
    {
        return None;
    }
    (hidden > 0).then(|| segments[..hidden].join("/"))
}

fn source_path_from_sidecar_relative_path(relative: &str) -> Option<String> {
    let encoded = relative
        .strip_prefix(".collab/image-overlays/")
        .or_else(|| relative.strip_prefix(".collab/pdf/"))?
        .strip_suffix(".json")?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .ok()?;
    String::from_utf8(bytes).ok()
}

#[tauri::command]
pub fn watch_vault(
    vault_path: String,
    app: AppHandle,
    state: State<AppState>,
) -> Result<(), String> {
    // Drop any existing watcher first
    {
        let mut watcher_lock = state.watcher.lock();
        *watcher_lock = None;
    }

    let app_handle = app.clone();
    let vault_path_clone = vault_path.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(500),
        move |res: DebounceEventResult| {
            if let Ok(events) = res {
                for event in events {
                    let path = &event.path;

                    // Get relative path string
                    let relative = path
                        .strip_prefix(&vault_path_clone)
                        .unwrap_or(path)
                        .to_string_lossy()
                        .replace('\\', "/");

                    if relative.starts_with(".collab/presence/") {
                        let _ = app_handle.emit("collab:presence-changed", serde_json::json!({}));
                        continue;
                    }

                    if relative == ".collab/chat/messages.json" {
                        let _ = app_handle.emit("collab:chat-updated", serde_json::json!({}));
                        continue;
                    }

                    if relative == ".collab/vault.json" {
                        let _ = app_handle.emit("collab:config-changed", serde_json::json!({}));
                        continue;
                    }

                    if let Some(source_path) = source_path_from_sidecar_relative_path(&relative) {
                        let payload = serde_json::json!({ "path": source_path, "vaultPath": vault_path_clone });
                        let _ = app_handle.emit("vault:file-modified", &payload);
                        continue;
                    }

                    if should_ignore_relative_path(&relative) {
                        if let Some(parent) = nearest_visible_relative_parent(&relative) {
                            let payload = serde_json::json!({ "path": parent, "vaultPath": vault_path_clone });
                            let _ = app_handle.emit("vault:file-modified", &payload);
                        }
                        continue;
                    }

                    // Skip all other .collab directory changes
                    if relative.starts_with(".collab/") {
                        continue;
                    }

                    let payload = serde_json::json!({ "path": relative, "vaultPath": vault_path_clone });
                    let _ = app_handle.emit("vault:file-modified", &payload);
                }
            }
        },
    )
    .map_err(|e| e.to_string())?;

    watch_visible_vault(&mut debouncer, Path::new(&vault_path))?;

    let mut watcher_lock = state.watcher.lock();
    *watcher_lock = Some(debouncer);

    Ok(())
}

fn watch_visible_vault(
    debouncer: &mut notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>,
    vault_path: &Path,
) -> Result<(), String> {
    debouncer
        .watcher()
        .watch(vault_path, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    // inotify can unwatch descendants of a recursive root. Other notify
    // backends may reject this; filtering above remains the portable fallback.
    for _ in walkdir::WalkDir::new(vault_path)
        .min_depth(1)
        .into_iter()
        .filter_entry(|entry| {
            let name = entry.file_name().to_string_lossy();
            if entry.file_type().is_dir() && (name.starts_with('.') || is_ignored_dir_name(&name)) {
                if name != ".collab" {
                    let _ = debouncer.watcher().unwatch(entry.path());
                }
                return false;
            }
            true
        })
    {}

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{nearest_visible_relative_parent, source_path_from_sidecar_relative_path};
    use base64::Engine as _;

    fn encode(path: &str) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(path)
    }

    #[test]
    fn bubbles_hidden_temp_file_changes_to_visible_parent() {
        assert_eq!(
            nearest_visible_relative_parent("Docs/.goutputstream-ABC123"),
            Some("Docs".to_string())
        );
    }

    #[test]
    fn skips_hidden_root_items_without_visible_parent() {
        assert_eq!(nearest_visible_relative_parent(".hidden-file"), None);
    }

    #[test]
    fn bubbles_nested_hidden_temp_paths_to_nearest_visible_parent() {
        assert_eq!(
            nearest_visible_relative_parent("Docs/Sub/.tmp-upload/spec.pdf.part"),
            Some("Docs/Sub".to_string())
        );
    }

    #[test]
    fn generated_and_unrelated_hidden_churn_never_bubbles() {
        for path in [
            "Docs/node_modules/pkg/index.js",
            "Docs/target/debug/foo",
            "Docs/.git/objects/pack",
            "Docs/.cache/data",
            "Docs/build/output.js",
        ] {
            assert_eq!(nearest_visible_relative_parent(path), None, "{path}");
        }
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn external_atomic_saves_and_renames_survive_generated_watch_pruning() {
        use notify_debouncer_mini::{new_debouncer, DebounceEventResult};
        use std::time::{Duration, Instant};
        let dir = tempfile::tempdir().unwrap();
        let docs = dir.path().join("Docs");
        std::fs::create_dir_all(docs.join("node_modules/pkg")).unwrap();
        std::fs::write(docs.join("original.md"), "before").unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = new_debouncer(
            Duration::from_millis(50),
            move |events: DebounceEventResult| {
                if let Ok(events) = events {
                    for event in events {
                        let _ = tx.send(event.path);
                    }
                }
            },
        )
        .unwrap();
        super::watch_visible_vault(&mut watcher, dir.path()).unwrap();
        std::fs::write(docs.join(".goutputstream-ABC"), "after").unwrap();
        std::fs::rename(docs.join(".goutputstream-ABC"), docs.join("saved.md")).unwrap();
        std::fs::rename(docs.join("original.md"), docs.join("renamed.md")).unwrap();
        std::fs::write(docs.join("node_modules/pkg/noise.md"), "generated").unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut visible = std::collections::HashSet::new();
        while Instant::now() < deadline {
            let Ok(path) = rx.recv_timeout(Duration::from_millis(100)) else {
                continue;
            };
            let relative = path
                .strip_prefix(dir.path())
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if !super::should_ignore_relative_path(&relative) {
                visible.insert(relative);
            }
            if visible.contains("Docs/saved.md") && visible.contains("Docs/renamed.md") {
                break;
            }
        }
        assert!(visible.contains("Docs/saved.md"), "{visible:?}");
        assert!(visible.contains("Docs/renamed.md"), "{visible:?}");
        assert!(!visible.iter().any(|p| p.contains("node_modules")));
    }

    #[test]
    fn decodes_image_overlay_sidecar_to_source_path() {
        let encoded = encode("Pictures/demo.png");
        assert_eq!(
            source_path_from_sidecar_relative_path(&format!(
                ".collab/image-overlays/{encoded}.json"
            )),
            Some("Pictures/demo.png".to_string()),
        );
    }

    #[test]
    fn decodes_pdf_sidecar_to_source_path() {
        let encoded = encode("Docs/spec.pdf");
        assert_eq!(
            source_path_from_sidecar_relative_path(&format!(".collab/pdf/{encoded}.json")),
            Some("Docs/spec.pdf".to_string()),
        );
    }
}

#[tauri::command]
pub fn unwatch_vault(state: State<AppState>) -> Result<(), String> {
    let mut watcher_lock = state.watcher.lock();
    *watcher_lock = None;
    // Runtime watch.stop is the local-vault close/switch boundary. Retire
    // plaintext and cancel indexing/listing even when the next vault is hosted.
    let mut active = state.active_vault.write();
    *state.encryption_key.write() = None;
    state.note_index.write().clear();
    *active = None;
    Ok(())
}
