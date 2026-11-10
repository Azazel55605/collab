//! Desktop main-window-only database IPC; no web/mobile/server execution surface.
use crate::database::{
    self,
    driver::{MetadataPage, MetadataRequest},
    Connected, SavedConnection, Workspace,
};
use collab_database::{ContractError, SessionBinding};
fn authorize(window: &tauri::WebviewWindow) -> Result<(), ContractError> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err(ContractError::WrongBinding)
    }
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
    database::profile_changed(&previous_owner, &next_owner).await;
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
) -> Result<(), ContractError> {
    authorize(&window)?;
    database::close_tab(&token, &binding).await
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
