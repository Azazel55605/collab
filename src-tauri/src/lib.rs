mod models;
mod state;
mod commands;
mod crypto;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {

    tauri::Builder::default()
        .manage(AppState::new())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // On Linux, WebKitGTK's touchpad pinch-to-zoom bypasses the `zoom-level` property
            // entirely — it calls WebPageProxy::scalePage() internally, firing no GObject signals.
            // The only way to block it is to intercept the GtkGestureZoom that WebKitWebViewBase
            // stores under the private key "wk-view-zoom-gesture" and deny gesture sequences
            // before the `scale-changed` signal (where actual zooming occurs) can fire.
            #[cfg(target_os = "linux")]
            {
                use tauri::Manager;
                use gtk::prelude::*;
                use webkit2gtk::{WebViewExt, SettingsExt};

                if let Some(webview_window) = app.get_webview_window("main") {
                    webview_window.with_webview(|wv| {
                        let webview = wv.inner();

                        // Force hardware acceleration so GPU compositing is active.
                        // Required for backdrop-filter blur on Wayland/Hyprland.
                        if let Some(settings) = WebViewExt::settings(&webview) {
                            SettingsExt::set_hardware_acceleration_policy(
                                &settings,
                                webkit2gtk::HardwareAccelerationPolicy::Always,
                            );
                        }

                        unsafe {
                            let key = b"wk-view-zoom-gesture\0".as_ptr() as *const std::os::raw::c_char;
                            let gesture_ptr = glib::gobject_ffi::g_object_get_data(
                                webview.as_ptr() as *mut glib::gobject_ffi::GObject,
                                key,
                            );
                            if !gesture_ptr.is_null() {
                                // Borrow the GtkGestureZoom without taking ownership.
                                let gesture: gtk::GestureZoom =
                                    glib::translate::from_glib_none(
                                        gesture_ptr as *mut gtk_sys::GtkGestureZoom
                                    );
                                // Connect to `begin` — WebKit only records initial state here;
                                // the actual zoom happens in `scale-changed`. Denying in `begin`
                                // prevents GTK from delivering further events for this sequence.
                                gesture.connect_begin(|g: &gtk::GestureZoom, _seq| {
                                    g.set_state(gtk::EventSequenceState::Denied);
                                });
                            }
                        }
                    }).ok();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // vault
            commands::vault::open_vault,
            commands::vault::create_vault,
            commands::vault::get_recent_vaults,
            commands::vault::show_open_vault_dialog,
            commands::vault::remove_recent_vault,
            commands::vault::rename_vault,
            commands::vault::export_vault,
            commands::vault::show_save_dialog,
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
            // collab — presence
            commands::collab::write_presence,
            commands::collab::read_all_presence,
            commands::collab::clear_presence,
            // collab — vault config
            commands::collab::get_vault_config,
            commands::collab::update_vault_config,
            commands::collab::register_known_user,
            commands::collab::claim_vault_ownership,
            // collab — chat
            commands::collab::send_chat_message,
            commands::collab::read_chat_messages,
            // collab — history
            commands::collab::create_snapshot,
            commands::collab::list_snapshots,
            commands::collab::read_snapshot,
            commands::collab::restore_snapshot,
            // collab — permissions
            commands::collab::invite_member,
            commands::collab::update_member_role,
            commands::collab::remove_member,
            // ui
            commands::ui::set_ui_zoom,
            // encryption
            commands::crypto::unlock_vault,
            commands::crypto::enable_vault_encryption,
            commands::crypto::disable_vault_encryption,
            commands::crypto::change_vault_password,
            // update
            commands::update::check_for_update,
            commands::update::download_and_install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
