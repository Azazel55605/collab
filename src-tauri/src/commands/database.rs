//! Desktop main-window-only database IPC; no web/mobile/server execution surface.
use crate::database::{
    self,
    driver::{MetadataPage, MetadataRequest},
    Connected, SavedConnection, Workspace,
};
use collab_database::{ContractError, SessionBinding};
use tauri::Manager;
fn authorize(window: &tauri::WebviewWindow) -> Result<(), ContractError> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err(ContractError::WrongBinding)
    }
}
fn authorize_execution(window: &tauri::WebviewWindow) -> Result<(), ContractError> {
    authorize(window)?;
    if crate::background_lifecycle::quit_pending(window.app_handle())
        || crate::background_lifecycle::is_quitting(window.app_handle())
    {
        return Err(ContractError::Busy);
    }
    Ok(())
}
fn root() -> Result<std::path::PathBuf, ContractError> {
    super::app_config_dir().map_err(|_| ContractError::ConnectionFailed)
}
#[tauri::command]
pub async fn database_activate(
    window: tauri::WebviewWindow,
    owner: String,
) -> Result<Workspace, ContractError> {
    authorize(&window)?;
    database::activate(&root()?, owner).await
}
#[tauri::command]
pub async fn database_deactivate(
    window: tauri::WebviewWindow,
    token: String,
) -> Result<(), ContractError> {
    authorize(&window)?;
    database::deactivate(&token).await
}
#[tauri::command]
pub async fn database_profile_changed(
    window: tauri::WebviewWindow,
    previous_owner: String,
    next_owner: String,
) -> Result<(), ContractError> {
    authorize(&window)?;
    database::profile_changed(&previous_owner, &next_owner).await?;
    Ok(())
}
#[tauri::command]
pub async fn database_save(
    window: tauri::WebviewWindow,
    token: String,
    config: SavedConnection,
    password: Option<String>,
) -> Result<SavedConnection, ContractError> {
    authorize(&window)?;
    database::save(&root()?, &token, config, password).await
}
#[tauri::command]
pub async fn database_remove(
    window: tauri::WebviewWindow,
    token: String,
    id: String,
) -> Result<(), ContractError> {
    authorize(&window)?;
    database::remove(&root()?, &token, &id).await
}
#[tauri::command]
pub async fn database_connect(
    window: tauri::WebviewWindow,
    token: String,
    id: String,
    password: Option<String>,
    test_only: bool,
) -> Result<Connected, ContractError> {
    authorize(&window)?;
    database::connect(&token, &id, password, test_only).await
}
#[tauri::command]
pub async fn database_disconnect(
    window: tauri::WebviewWindow,
    token: String,
    id: String,
) -> Result<(), ContractError> {
    authorize(&window)?;
    database::disconnect(&token, &id).await
}
#[tauri::command]
pub async fn database_open_tab(
    window: tauri::WebviewWindow,
    token: String,
    id: String,
    database: String,
) -> Result<SessionBinding, ContractError> {
    authorize(&window)?;
    database::open_tab(&token, &id, database).await
}
#[tauri::command]
pub async fn database_close_tab(
    window: tauri::WebviewWindow,
    token: String,
    binding: SessionBinding,
    discard: Option<bool>,
) -> Result<(), ContractError> {
    authorize(&window)?;
    database::close_tab(&token, &binding, discard.unwrap_or(false)).await
}
#[tauri::command]
pub async fn database_metadata(
    window: tauri::WebviewWindow,
    token: String,
    connection_id: String,
    binding: Option<SessionBinding>,
    request: MetadataRequest,
) -> Result<MetadataPage, ContractError> {
    authorize(&window)?;
    database::metadata(&token, &connection_id, binding, request).await
}

#[tauri::command]
pub async fn database_query_start(
    window: tauri::WebviewWindow,
    token: String,
    binding: SessionBinding,
    sql: String,
    selection: Option<collab_database::SourceRange>,
) -> Result<String, ContractError> {
    authorize_execution(&window)?;
    database::start_query(&token, binding, sql, selection, false).await
}
#[tauri::command]
pub async fn database_query_rollback(
    window: tauri::WebviewWindow,
    token: String,
    binding: SessionBinding,
) -> Result<String, ContractError> {
    authorize_execution(&window)?;
    database::manual_transaction(
        &token,
        binding,
        database::query::TransactionAction::Rollback,
    )
    .await
}
#[tauri::command]
pub async fn database_query_poll(
    window: tauri::WebviewWindow,
    token: String,
    binding: SessionBinding,
    query_id: String,
    after: Option<u64>,
) -> Result<database::query::Poll, ContractError> {
    authorize(&window)?;
    let live = database::query_live(&token, &binding).await?;
    let result = live.query.poll(&query_id, after).await?;
    database::query_live(&token, &binding).await?;
    Ok(result)
}
#[tauri::command]
pub async fn database_query_cancel(
    window: tauri::WebviewWindow,
    token: String,
    binding: SessionBinding,
    query_id: String,
) -> Result<(), ContractError> {
    authorize(&window)?;
    database::query_live(&token, &binding)
        .await?
        .query
        .cancel(&query_id)
}
#[tauri::command]
pub async fn database_query_status(
    window: tauri::WebviewWindow,
    token: String,
    binding: SessionBinding,
) -> Result<database::query::Status, ContractError> {
    authorize(&window)?;
    Ok(database::query_live(&token, &binding).await?.query.status())
}
#[tauri::command]
pub async fn database_query_history(
    window: tauri::WebviewWindow,
    token: String,
    binding: SessionBinding,
    clear: bool,
) -> Result<Vec<database::query::HistoryEntry>, ContractError> {
    authorize(&window)?;
    let live = database::query_live(&token, &binding).await?;
    if clear {
        live.query.clear_history();
    }
    Ok(live.query.history())
}
#[tauri::command]
pub async fn database_can_quit(window: tauri::WebviewWindow) -> Result<bool, ContractError> {
    authorize(&window)?;
    Ok(database::can_quit().await)
}
#[tauri::command]
pub async fn database_query_export(
    window: tauri::WebviewWindow,
    token: String,
    binding: SessionBinding,
    content: String,
    json: bool,
) -> Result<bool, ContractError> {
    authorize(&window)?;
    database::query_live(&token, &binding).await?;
    if content.len() > 16 << 20 {
        return Err(ContractError::LimitReached);
    }
    use tauri_plugin_dialog::DialogExt;
    let name = if json {
        "query-results.json"
    } else {
        "query-results.csv"
    };
    let app = window.app_handle().clone();
    let path = tokio::task::spawn_blocking(move || {
        app.dialog().file().set_file_name(name).blocking_save_file()
    })
    .await
    .map_err(|_| ContractError::ConnectionFailed)?;
    let Some(path) = path else {
        return Ok(false);
    };
    let path = path
        .into_path()
        .map_err(|_| ContractError::InvalidParameter)?;
    database::query_live(&token, &binding).await?;
    tokio::task::spawn_blocking(move || {
        use std::io::Write;
        let parent = path.parent().ok_or(ContractError::InvalidParameter)?;
        let mut file =
            tempfile::NamedTempFile::new_in(parent).map_err(|_| ContractError::ConnectionFailed)?;
        file.write_all(content.as_bytes())
            .map_err(|_| ContractError::ConnectionFailed)?;
        file.persist(path)
            .map_err(|_| ContractError::ConnectionFailed)?;
        Ok(true)
    })
    .await
    .map_err(|_| ContractError::ConnectionFailed)?
}

#[tauri::command]
pub async fn database_table_browse(
    window: tauri::WebviewWindow,
    token: String,
    binding: SessionBinding,
    request: database::query::BrowseRequest,
) -> Result<String, ContractError> {
    authorize_execution(&window)?;
    database::browse_query(&token, binding, request).await
}

#[tauri::command]
pub async fn database_manual_transaction(
    window: tauri::WebviewWindow,
    token: String,
    binding: SessionBinding,
    action: database::query::TransactionAction,
) -> Result<String, ContractError> {
    authorize_execution(&window)?;
    database::manual_transaction(&token, binding, action).await
}
#[tauri::command]
pub async fn database_edit_load(
    window: tauri::WebviewWindow,
    token: String,
    binding: SessionBinding,
    request: database::query::BrowseRequest,
) -> Result<database::edit::Page, database::edit::Failure> {
    authorize_execution(&window)?;
    database::edit_load(&token, binding, request).await
}
#[tauri::command]
pub async fn database_edit_apply(
    window: tauri::WebviewWindow,
    token: String,
    binding: SessionBinding,
    request: database::edit::ApplyRequest,
) -> Result<database::edit::ApplyResult, database::edit::Failure> {
    authorize_execution(&window)?;
    database::edit_apply(&token, binding, request).await
}
