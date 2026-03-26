mod models;
mod state;
mod commands;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // On Linux, WebKitGTK's DMA-BUF renderer and GPU compositing can crash
    // the web process (manifesting as a blank window) on certain kernel/driver
    // combinations.  Disabling them forces software compositing which is stable.
    #[cfg(target_os = "linux")]
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
    }

    tauri::Builder::default()
        .manage(AppState::new())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            // vault
            commands::vault::open_vault,
            commands::vault::create_vault,
            commands::vault::get_recent_vaults,
            commands::vault::show_open_vault_dialog,
            // files
            commands::files::list_vault_files,
            commands::files::read_note,
            commands::files::write_note,
            commands::files::create_note,
            commands::files::delete_note,
            commands::files::rename_note,
            commands::files::create_folder,
            // index
            commands::index::build_note_index,
            commands::index::get_backlinks,
            commands::index::search_notes,
            // watcher
            commands::watcher::watch_vault,
            commands::watcher::unwatch_vault,
            // collab
            commands::collab::write_presence,
            commands::collab::read_all_presence,
            commands::collab::clear_presence,
            commands::collab::get_vault_config,
            commands::collab::update_vault_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
