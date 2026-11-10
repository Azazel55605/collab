use super::*;
use driver::MetadataRequest;
fn config() -> SavedConnection {
    SavedConnection {
        id: String::new(),
        label: "Fixture".into(),
        environment: "Test".into(),
        host: "localhost".into(),
        port: 1433,
        database: "master".into(),
        username: "sa".into(),
        certificate_hostname: None,
        remember_password: false,
        credential_id: None,
        retired_credentials: vec![],
    }
}
#[test]
fn profiles_reject_connection_string_injection_and_do_not_store_secrets() {
    let mut c = config();
    c.id = Uuid::new_v4().to_string();
    assert!(c.validate().is_ok());
    for bad in [
        "localhost;TrustServerCertificate=true",
        "localhost,1433",
        "host\\instance",
        "host\n",
    ] {
        c.host = bad.into();
        assert!(c.validate().is_err());
    }
    let root = tempfile::tempdir().unwrap();
    c = config();
    c.id = Uuid::new_v4().to_string();
    persist(root.path(), "../../profile", &[c]).unwrap();
    let profiles = load(root.path(), "../../profile").unwrap();
    assert_eq!(profiles.len(), 1);
    assert!(!std::fs::read_to_string(path(root.path(), "../../profile"))
        .unwrap()
        .contains("password\":\""));
}
#[tokio::test]
async fn registry_tokens_expire_on_profile_switch_and_saved_fields_are_native_owned() {
    let root = tempfile::tempdir().unwrap();
    let first = activate(root.path(), "test-profile-a".into())
        .await
        .unwrap();
    let saved = save(root.path(), &first.token, config(), None)
        .await
        .unwrap();
    assert!(Uuid::parse_str(&saved.id).is_ok());
    let mut forged = config();
    forged.id = Uuid::new_v4().to_string();
    assert!(matches!(
        save(root.path(), &first.token, forged, None).await,
        Err(E::WrongBinding)
    ));
    profile_changed("test-profile-a", "test-profile-b").await;
    let second = activate(root.path(), "test-profile-b".into())
        .await
        .unwrap();
    assert!(second.profiles.is_empty());
    assert!(matches!(
        disconnect(&first.token, "missing").await,
        Err(E::WrongBinding)
    ));
    profile_changed("test-profile-b", "test-profile-a").await;
    let restored = activate(root.path(), "test-profile-a".into())
        .await
        .unwrap();
    assert_eq!(restored.profiles.len(), 1);
    assert_ne!(first.token, restored.token);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut pending_config = restored.profiles[0].clone();
    pending_config.port = listener.local_addr().unwrap().port();
    let saved = save(root.path(), &restored.token, pending_config, None)
        .await
        .unwrap();
    let token = restored.token.clone();
    let id = saved.id.clone();
    let pending = tokio::spawn(async move {
        connect(
            &token,
            &id,
            Some("disposable-no-login-handshake".into()),
            false,
        )
        .await
    });
    let (_socket, _) = tokio::time::timeout(std::time::Duration::from_secs(3), listener.accept())
        .await
        .unwrap()
        .unwrap();
    profile_changed("test-profile-a", "test-profile-c").await;
    assert!(matches!(
        tokio::time::timeout(std::time::Duration::from_secs(3), pending)
            .await
            .unwrap()
            .unwrap(),
        Err(E::WrongBinding)
    ));
    assert_eq!(slots().available_permits(), 8);
    assert!(matches!(
        activate(root.path(), "test-profile-a".into()).await,
        Err(E::WrongBinding)
    ));
    assert!(matches!(
        deactivate(&restored.token).await,
        Err(E::WrongBinding)
    ));
}
/// Run only from scripts/database-driver-spike.py --native-adapter. Never accepts
/// an arbitrary database URL; the harness owns this loopback Developer instance.
#[tokio::test]
#[ignore]
async fn real_disposable_registry_connections_and_metadata() {
    assert_eq!(
        std::env::var("COLLAB_DATABASE_DISPOSABLE_FIXTURE").as_deref(),
        Ok("yes")
    );
    let password =
        std::fs::read_to_string(std::env::var("COLLAB_DB_SPIKE_PASSWORD_FILE").unwrap()).unwrap();
    let root = tempfile::tempdir().unwrap();
    let w = activate(root.path(), "fixture-profile".into())
        .await
        .unwrap();
    let mut c = config();
    c.port = std::env::var("COLLAB_DB_SPIKE_PORT")
        .unwrap()
        .parse()
        .unwrap();
    c.database = "collab_phase0".into();
    let saved = save(root.path(), &w.token, c, None).await.unwrap();
    connect(&w.token, &saved.id, Some(password.clone()), true)
        .await
        .unwrap();
    assert!(activate(root.path(), "fixture-profile".into())
        .await
        .unwrap()
        .connections
        .is_empty());
    assert!(matches!(
        connect(
            &w.token,
            &saved.id,
            Some("wrong-disposable-password".into()),
            false
        )
        .await,
        Err(E::AuthenticationFailed)
    ));
    let mut invalid = config();
    invalid.port = saved.port;
    invalid.database = saved.database.clone();
    invalid.certificate_hostname = Some("wrong-name.invalid".into());
    let invalid = save(root.path(), &w.token, invalid, None).await.unwrap();
    assert!(matches!(
        connect(&w.token, &invalid.id, Some(password.clone()), false).await,
        Err(E::TlsRejected)
    ));
    let a = connect(&w.token, &saved.id, Some(password.clone()), false)
        .await
        .unwrap();
    let b = connect(&w.token, &saved.id, Some(password.clone()), false)
        .await
        .unwrap();
    assert_ne!(a.id, b.id);
    let page = metadata(
        &w.token,
        &a.id,
        None,
        MetadataRequest::Databases {
            after: String::new(),
        },
    )
    .await
    .unwrap();
    assert!(page.items.iter().any(|i| i.name == "collab_phase0"));
    let ta = open_tab(&w.token, &a.id, "collab_phase0".into())
        .await
        .unwrap();
    let tb = open_tab(&w.token, &b.id, "master".into()).await.unwrap();
    let mut forged = ta.clone();
    forged.database = "master".into();
    assert!(matches!(
        close_tab(&w.token, &forged).await,
        Err(E::WrongBinding)
    ));
    assert!(matches!(
        metadata(
            &w.token,
            &b.id,
            Some(ta.clone()),
            MetadataRequest::Schemas { after: 0 }
        )
        .await,
        Err(E::WrongBinding)
    ));
    let schemas = metadata(
        &w.token,
        &a.id,
        Some(ta.clone()),
        MetadataRequest::Schemas { after: 0 },
    )
    .await
    .unwrap();
    assert!(schemas.items.iter().any(|i| i.name == "dbo"));
    let dbo = schemas
        .items
        .iter()
        .find(|i| i.name == "dbo")
        .unwrap()
        .id
        .parse()
        .unwrap();
    let objects = metadata(
        &w.token,
        &a.id,
        Some(ta.clone()),
        MetadataRequest::Objects {
            schema_id: dbo,
            after: 0,
        },
    )
    .await
    .unwrap();
    assert_eq!(objects.items.len(), 100);
    assert!(objects.next.is_some());
    let second = metadata(
        &w.token,
        &a.id,
        Some(ta.clone()),
        MetadataRequest::Objects {
            schema_id: dbo,
            after: objects.next.unwrap().parse().unwrap(),
        },
    )
    .await
    .unwrap();
    assert!(second.items.len() >= 6);
    assert!(second
        .items
        .iter()
        .all(|i| !objects.items.iter().any(|old| old.id == i.id)));
    let table = objects
        .items
        .iter()
        .chain(second.items.iter())
        .find(|i| i.name == "phase1_metadata")
        .unwrap()
        .id
        .parse()
        .unwrap();
    let columns = metadata(
        &w.token,
        &a.id,
        Some(ta.clone()),
        MetadataRequest::Columns {
            object_id: table,
            after: 0,
        },
    )
    .await
    .unwrap();
    assert!(columns.items.iter().any(|i| i.name == "label"));
    let indexes = metadata(
        &w.token,
        &a.id,
        Some(ta.clone()),
        MetadataRequest::Indexes {
            object_id: table,
            after: 0,
        },
    )
    .await
    .unwrap();
    assert!(indexes.items.iter().any(|i| i.name == "phase1_label"));
    let injected = metadata(
        &w.token,
        &a.id,
        None,
        MetadataRequest::Databases {
            after: "zz'; DROP DATABASE collab_phase0;--".into(),
        },
    )
    .await
    .unwrap();
    assert!(injected.items.is_empty());
    disconnect(&w.token, &a.id).await.unwrap();
    let w2 = activate(root.path(), "fixture-profile".into())
        .await
        .unwrap();
    assert_eq!(w2.tabs.len(), 1);
    assert_eq!(w2.tabs[0], tb);
    assert!(matches!(
        close_tab(&w.token, &ta).await,
        Err(E::WrongBinding)
    ));
    close_tab(&w.token, &tb).await.unwrap();
    let mut held = vec![];
    for _ in 0..7 {
        held.push(
            connect(&w.token, &saved.id, Some(password.clone()), false)
                .await
                .unwrap(),
        );
    }
    assert!(matches!(
        connect(&w.token, &saved.id, Some(password), false).await,
        Err(E::LimitReached)
    ));
    {
        profile_changed("fixture-profile", "other-fixture-profile").await;
        activate(root.path(), "other-fixture-profile".into())
            .await
            .unwrap()
    };
    activate(root.path(), "other-fixture-profile".into())
        .await
        .unwrap();
    assert_eq!(slots().available_permits(), 8);
    assert!(matches!(
        metadata(&w.token, &b.id, None, MetadataRequest::Schemas { after: 0 }).await,
        Err(E::WrongBinding)
    ));
}
