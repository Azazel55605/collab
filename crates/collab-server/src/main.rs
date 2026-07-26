use anyhow::Context;
use collab_server::{
    app::{spawn_backup_scheduler, spawn_calendar_subscription_worker, spawn_maintenance_worker},
    build_router, database,
    storage::FileSystemBlobStorage,
    AppState, ServerConfig,
};
use std::sync::Arc;
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = ServerConfig::load().context("failed to load server configuration")?;
    init_tracing(&config);

    let pool = database::connect_and_migrate(&config.database_url)
        .await
        .context("failed to connect to PostgreSQL or run migrations")?;
    let blob_storage = Arc::new(
        FileSystemBlobStorage::new(&config.blob_dir)
            .await
            .context("failed to initialize blob storage")?,
    );
    let state = AppState::new(config.clone(), pool, blob_storage);
    spawn_backup_scheduler(state.clone());
    spawn_maintenance_worker(state.clone());
    spawn_calendar_subscription_worker(state.clone());
    let listener = TcpListener::bind(config.bind_address())
        .await
        .with_context(|| format!("failed to bind {}", config.bind_address()))?;

    tracing::info!(address = %config.bind_address(), "collab server listening");
    axum::serve(
        listener,
        build_router(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    .context("server failed")
}

fn init_tracing(config: &ServerConfig) {
    let filter = EnvFilter::try_new(&config.log_filter).unwrap_or_else(|_| EnvFilter::new("info"));
    match config.log_format {
        collab_server::LogFormat::Json => {
            tracing_subscriber::fmt()
                .with_env_filter(filter)
                .json()
                .init();
        }
        collab_server::LogFormat::Pretty => {
            tracing_subscriber::fmt()
                .with_env_filter(filter)
                .compact()
                .init();
        }
    }
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install terminate handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}
