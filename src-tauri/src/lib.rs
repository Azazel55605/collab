mod android_jni;
mod android_notifications;
mod background;
#[cfg(not(mobile))]
mod background_lifecycle;
mod commands;
mod crypto;
#[cfg(not(mobile))]
mod desktop_notifications;
mod hosted_client;
mod hosted_session;
mod models;
mod notifications;
mod server_token_store;
mod state;
#[cfg(test)]
pub mod test_support;

use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default().manage(AppState::new());

    // This must be the first plugin so a second launch hands focus back before
    // any other plugin setup performs process-local work.
    #[cfg(not(mobile))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        background_lifecycle::show_main_window(app);
    }));

    #[cfg(all(not(mobile), target_os = "linux"))]
    let builder = if std::env::var_os("FLATPAK_ID").is_some() {
        builder
    } else {
        builder.plugin(
            tauri_plugin_updater::Builder::new()
                // Pubkey is also declared in tauri.conf.json, but passing it
                // here ensures the AppImage updater picks it up correctly —
                // some Tauri 2 versions fail to propagate the config-embedded
                // key to the runtime updater on Linux.
                .pubkey("dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDQ0MEQwRUZGRUU2NzFGMUIKUldRYkgyZnUvdzROUk9heXVVRlJyR2NzUGh2YU1rWDQ2dS9ZV2xoa0hYdElJYXFEMjRXQUZ6ekwK")
                .build(),
        )
    };

    #[cfg(all(not(mobile), not(target_os = "linux")))]
    let builder = builder.plugin(
        tauri_plugin_updater::Builder::new()
            // Pubkey is also declared in tauri.conf.json, but passing it
            // here ensures the AppImage updater picks it up correctly —
            // some Tauri 2 versions fail to propagate the config-embedded
            // key to the runtime updater on Linux.
            .pubkey("dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDQ0MEQwRUZGRUU2NzFGMUIKUldRYkgyZnUvdzROUk9heXVVRlJyR2NzUGh2YU1rWDQ2dS9ZV2xoa0hYdElJYXFEMjRXQUZ6ekwK")
            .build(),
    );

    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());

    #[cfg(not(mobile))]
    let builder = builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ));

    builder
        .setup(|app| {
            #[cfg(not(mobile))]
            background_lifecycle::setup_background_lifecycle(app)?;
            #[cfg(mobile)]
            let _ = app;

            // On Linux, WebKitGTK's touchpad pinch-to-zoom bypasses the `zoom-level` property
            // entirely — it calls WebPageProxy::scalePage() internally, firing no GObject signals.
            // The only way to block it is to intercept the GtkGestureZoom that WebKitWebViewBase
            // stores under the private key "wk-view-zoom-gesture" and deny gesture sequences
            // before the `scale-changed` signal (where actual zooming occurs) can fire.
            #[cfg(target_os = "linux")]
            {
                use gtk::prelude::*;
                use tauri::Manager;
                use webkit2gtk::{SettingsExt, WebViewExt};

                if let Some(webview_window) = app.get_webview_window("main") {
                    webview_window
                        .with_webview(|wv| {
                            let webview = wv.inner();

                            // Force hardware acceleration so GPU compositing is active.
                            // Required for backdrop-filter blur on Wayland/Hyprland.
                            if let Some(settings) = WebViewExt::settings(&webview) {
                                SettingsExt::set_hardware_acceleration_policy(
                                    &settings,
                                    webkit2gtk::HardwareAccelerationPolicy::Always,
                                );
                                // Keep touchpad scrolling predictable across Linux WebKitGTK builds.
                                // AppImage's bundled runtime has been especially prone to rough
                                // inertial scrolling and accidental horizontal swipe navigation.
                                SettingsExt::set_enable_smooth_scrolling(&settings, true);
                                SettingsExt::set_enable_back_forward_navigation_gestures(
                                    &settings, false,
                                );
                            }

                            unsafe {
                                let key = b"wk-view-zoom-gesture\0".as_ptr()
                                    as *const std::os::raw::c_char;
                                let gesture_ptr = glib::gobject_ffi::g_object_get_data(
                                    webview.as_ptr() as *mut glib::gobject_ffi::GObject,
                                    key,
                                );
                                if !gesture_ptr.is_null() {
                                    // Borrow the GtkGestureZoom without taking ownership.
                                    let gesture: gtk::GestureZoom = glib::translate::from_glib_none(
                                        gesture_ptr as *mut gtk_sys::GtkGestureZoom,
                                    );
                                    // Connect to `begin` — WebKit only records initial state here;
                                    // the actual zoom happens in `scale-changed`. Denying in `begin`
                                    // prevents GTK from delivering further events for this sequence.
                                    gesture.connect_begin(|g: &gtk::GestureZoom, _seq| {
                                        g.set_state(gtk::EventSequenceState::Denied);
                                    });
                                }
                            }
                        })
                        .ok();
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // user calendar profile store
            commands::calendar::calendar_list,
            commands::calendar::calendar_save,
            commands::calendar::calendar_replace_generated_kanban,
            commands::calendar::calendar_replace_subscription,
            commands::calendar::calendar_list_subscriptions,
            commands::calendar::calendar_save_subscription,
            commands::calendar::calendar_delete_subscription,
            commands::calendar::calendar_save_with_operation,
            commands::calendar::calendar_delete,
            commands::calendar::calendar_cleanup,
            commands::calendar::calendar_list_items,
            commands::calendar::calendar_upsert_item,
            commands::calendar::calendar_upsert_items,
            commands::calendar::calendar_list_calendar_items,
            commands::calendar::calendar_delete_item,
            commands::calendar::calendar_search_items,
            commands::calendar::calendar_acknowledge_operations,
            commands::calendar::calendar_read_sync_state,
            commands::calendar::calendar_write_sync_state,
            commands::calendar::calendar_apply_remote_changes,
            commands::calendar::calendar_list_pending_operations,
            commands::calendar::calendar_list_failed_operations,
            commands::calendar::calendar_mark_operation_failed,
            commands::calendar::calendar_retry_operation,
            commands::calendar::calendar_discard_operation,
            commands::calendar::calendar_remove_hosted_cache,
            commands::calendar::calendar_list_mirror_groups,
            commands::calendar::calendar_save_mirror_group,
            commands::calendar::calendar_delete_mirror_group,
            commands::calendar::calendar_list_mirror_anchors,
            commands::calendar::calendar_save_mirror_anchors,
            commands::calendar::calendar_list_mirror_conflicts,
            commands::calendar::calendar_save_mirror_conflict,
            commands::calendar::calendar_list_mirror_items,
            // native notification inbox and schedule ledger
            commands::notifications::notification_reconcile,
            commands::notifications::notification_cancel_category,
            commands::notifications::notification_list_inbox,
            commands::notifications::notification_sync_remote,
            commands::notifications::notification_preferences_get,
            commands::notifications::notification_preferences_save,
            commands::notifications::notification_mark_read,
            commands::notifications::notification_dismiss,
            commands::notifications::notification_snooze,
            commands::notifications::notification_mark_failed,
            commands::notifications::notification_retry,
            commands::notifications::notification_create_action_token,
            commands::notifications::notification_consume_action_token,
            commands::notifications::notification_cleanup,
            commands::notifications::notification_list_reconciliation_requests,
            commands::notifications::notification_reconcile_platform_schedule,
            commands::notifications::notification_permission_status,
            commands::notifications::notification_request_permission,
            commands::notifications::notification_send_test,
            commands::notifications::notification_android_exact_alarm_status,
            commands::notifications::notification_android_open_exact_alarm_settings,
            commands::notifications::notification_android_take_pending_open,
            commands::background::background_runtime_probe,
            commands::background::background_server_list,
            commands::background::background_server_replace,
            commands::background::background_server_upsert,
            commands::background::background_server_remove,
            commands::background::background_job_run,
            commands::background::background_job_get,
            commands::background::background_job_list,
            commands::background::background_job_cancel,
            commands::background::background_job_aggregate,
            commands::background::background_status_snapshot,
            commands::background::background_settings_get,
            commands::background::background_settings_save,
            commands::background::background_sync_registered,
            commands::background::background_android_reconcile,
            commands::background::background_android_request_immediate,
            commands::background::background_android_cancel_profile,
            commands::background::background_android_verify,
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
            commands::files::read_note_asset_data_url,
            commands::files::resolve_vault_file_path,
            commands::files::write_downloaded_file,
            commands::files::write_temp_file_for_drag,
            commands::files::sidecars::read_image_overlay,
            commands::files::sidecars::write_image_overlay,
            commands::files::sidecars::delete_image_overlay,
            commands::files::sidecars::read_pdf_sidecar_state,
            commands::files::sidecars::write_pdf_sidecar_state,
            commands::files::sidecars::read_cached_document_preview_data_url,
            commands::files::sidecars::write_cached_document_preview_data_url,
            commands::files::save_generated_image,
            commands::files::import_asset_into_vault,
            commands::files::read_file_for_upload,
            commands::files::write_note,
            commands::files::create_note,
            commands::files::delete_note,
            commands::files::move_note_to_trash,
            commands::files::list_trash_entries,
            commands::files::restore_trashed_item,
            commands::files::purge_trashed_item,
            commands::files::purge_all_trash,
            commands::files::preview_rename_move,
            commands::files::list_file_references,
            commands::files::rename_note,
            commands::files::create_folder,
            // web
            commands::web::fetch_link_preview,
            commands::web::fetch_calendar_feed,
            // ocr
            commands::ocr::list_ocr_language_packs,
            commands::ocr::install_ocr_language_pack,
            commands::ocr::remove_ocr_language_pack,
            commands::ocr::read_ocr_language_pack_data,
            commands::ocr::recognize_image_data_url,
            commands::ocr::recognize_image_data_url_words,
            // hosted server connection
            commands::server::connect_server,
            commands::server::reauthenticate_server,
            commands::server::reconnect_server,
            commands::server::disconnect_server,
            commands::server::server_connection_statuses,
            commands::server::server_health_check,
            commands::server::server_has_saved_session,
            commands::server::hosted_vault_request,
            commands::server::hosted_calendar_request,
            commands::server::hosted_vault_asset_data_url,
            commands::server::hosted_vault_upload_file,
            commands::server::hosted_vault_download_entry,
            commands::server::hosted_user_directory,
            commands::server::hosted_vault_export_zip,
            commands::server::hosted_ws_ticket,
            commands::live_ws::live_ws_connect,
            commands::live_ws::live_ws_send,
            commands::live_ws::live_ws_close,
            commands::mobile::mobile_app_data_probe,
            commands::mobile::mobile_exit_app,
            // templates
            commands::templates::list_kanban_templates,
            commands::templates::save_kanban_template,
            commands::templates::delete_kanban_template,
            commands::templates::copy_kanban_template,
            commands::templates::import_kanban_template_from_file,
            commands::templates::export_kanban_template_to_file,
            commands::templates::apply_kanban_template,
            commands::templates::create_blank_kanban_template,
            commands::templates::list_kanban_filter_presets,
            commands::templates::save_kanban_filter_preset,
            commands::templates::delete_kanban_filter_preset,
            commands::templates::copy_kanban_filter_preset,
            commands::templates::list_kanban_automation_presets,
            commands::templates::save_kanban_automation_preset,
            commands::templates::delete_kanban_automation_preset,
            commands::templates::copy_kanban_automation_preset,
            commands::templates::list_note_snippets,
            commands::templates::save_note_snippet,
            commands::templates::delete_note_snippet,
            commands::templates::list_logic_components,
            commands::templates::save_logic_component,
            commands::templates::delete_logic_component,
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
            commands::collab::register_known_user,
            // collab — chat
            commands::collab::send_chat_message,
            commands::collab::read_chat_messages,
            // collab — history
            commands::collab::create_snapshot,
            commands::collab::list_snapshots,
            commands::collab::read_snapshot,
            commands::collab::delete_snapshot,
            commands::collab::clear_snapshot_history,
            commands::collab::restore_snapshot,
            // first-party circuit simulation
            commands::circuit::circuit_solve_dc,
            commands::circuit::circuit_start_dc,
            commands::circuit::circuit_start_dc_sweep,
            commands::circuit::circuit_start_transient,
            commands::circuit::circuit_job_status,
            commands::circuit::circuit_cancel_job,
            commands::circuit::circuit_take_job_result,
            commands::circuit::circuit_read_sweep_chunk,
            commands::circuit::circuit_read_transient_chunk,
            commands::circuit::circuit_discard_job,
            // ui
            commands::ui::set_ui_zoom,
            commands::ui::host_os,
            commands::ui::is_appimage,
            commands::ui::is_flatpak,
            commands::ui::should_disable_blur,
            // encryption
            commands::crypto::unlock_vault,
            commands::crypto::enable_vault_encryption,
            commands::crypto::disable_vault_encryption,
            commands::crypto::change_vault_password,
            // update
            commands::update::check_for_update,
            commands::update::download_and_install_update,
            // native hosted-vault replica store (offline sync)
            commands::replica::replica_seed,
            commands::replica::replica_list,
            commands::replica::replica_read_manifest,
            commands::replica::replica_read_sync_state,
            commands::replica::replica_write_sync_state,
            commands::replica::replica_enqueue_operation,
            commands::replica::replica_list_pending_operations,
            commands::replica::replica_update_operation_status,
            commands::replica::replica_record_operation_failure,
            commands::replica::replica_remove_operation,
            commands::replica::replica_record_tombstone,
            commands::replica::replica_list_tombstones,
            commands::replica::replica_remove_tombstone,
            commands::replica::replica_write_logic_components,
            commands::replica::replica_read_logic_components,
            commands::replica::replica_cache_document,
            commands::replica::replica_read_cached_document,
            commands::replica::replica_cache_asset,
            commands::replica::replica_read_cached_asset,
            commands::replica::replica_cached_content_status,
            commands::replica::replica_cache_crdt_state,
            commands::replica::replica_read_crdt_state,
            commands::replica::replica_clear_crdt_state,
            commands::replica::replica_verify,
            commands::replica::replica_rebuild,
            commands::replica::replica_cleanup,
            commands::replica::replica_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
