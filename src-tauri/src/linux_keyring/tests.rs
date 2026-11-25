use super::*;
use crate::commands::replica::replica_key;
use std::{fs, process::Command};

// Run explicitly with cargo test -p collab private_gnome_keyring -- --ignored.
// The parent starts a private bus and daemon with an empty data directory so
// this test can lock a collection without touching anyone's login keyring.
#[test]
#[ignore = "requires dbus-run-session and gnome-keyring-daemon"]
fn private_gnome_keyring() {
    if std::env::var_os("COLLAB_TEST_KEYRING_BUS").is_none() {
        let dir = tempfile::tempdir().unwrap();
        for phase in ["exercise", "reopen"] {
            let run = dir.path().join(phase);
            fs::create_dir(&run).unwrap();
            let status = Command::new("dbus-run-session")
                .args(["--", "sh", "-ec", r#"
                    export GNOME_KEYRING_CONTROL="$XDG_RUNTIME_DIR/keyring"
                    printf %s fixture | gnome-keyring-daemon --unlock --control-directory "$GNOME_KEYRING_CONTROL" >/dev/null
                    gnome-keyring-daemon --start --components=secrets --control-directory "$GNOME_KEYRING_CONTROL" >/dev/null
                    test -f "$XDG_DATA_HOME/keyrings/login.keyring"
                    export COLLAB_TEST_KEYRING_BUS="$DBUS_SESSION_BUS_ADDRESS"
                    exec "$1" linux_keyring::tests::private_gnome_keyring --exact --ignored
                "#, "fixture"])
                .arg(std::env::current_exe().unwrap())
                .env("COLLAB_TEST_KEYRING_PHASE", phase)
                .env("XDG_RUNTIME_DIR", run)
                .env("XDG_DATA_HOME", dir.path().join("data"))
                .env("XDG_CONFIG_HOME", dir.path().join("config"))
                .env_remove("DISPLAY").env_remove("WAYLAND_DISPLAY")
                .status().unwrap();
            assert!(status.success());
        }
        return;
    }
    assert_eq!(
        std::env::var("COLLAB_TEST_KEYRING_BUS").unwrap(),
        std::env::var("DBUS_SESSION_BUS_ADDRESS").unwrap()
    );
    let service = "collab-keyring-test";
    let account = "fixture";
    let entry =
        keyring::secret_service::SsCredential::new_with_target(None, service, account).unwrap();
    let interactive = keyring::Entry::new_with_credential(Box::new(entry));
    let quiet = || UnlockedCredential::open(service, account).unwrap();
    if std::env::var("COLLAB_TEST_KEYRING_PHASE").unwrap() == "reopen" {
        assert_eq!(quiet().read().unwrap().as_deref(), Some("third"));
        return;
    }
    assert!(quiet().read().unwrap().is_none());
    quiet().write("first").unwrap();
    assert_eq!(interactive.get_password().unwrap(), "first");
    interactive.set_password("second").unwrap();
    quiet().write("third").unwrap();
    assert_eq!(quiet().read().unwrap().as_deref(), Some("third"));

    let url = format!("https://{}.invalid", uuid::Uuid::new_v4());
    let key = replica_key(&url, "vault", true).unwrap().unwrap();
    let bus = Connection::new_session().unwrap();
    let root = proxy(&bus, &ROOT.into());
    let (collection,): (Path,) = root
        .method_call(SERVICE, "ReadAlias", ("default",))
        .unwrap();
    tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(rotate_during_lock(collection.clone()));
    for _ in 0..3 {
        assert_eq!(
            UnlockedCredential::open(service, account).err().as_deref(),
            Some(LOCKED)
        );
        assert_eq!(
            UnlockedCredential::open(service, "absent").err().as_deref(),
            Some(LOCKED)
        );
        assert_eq!(replica_key(&url, "vault", true).unwrap(), Some(key));
        assert_eq!(replica_key(&url, "new-vault", true).unwrap_err(), LOCKED);
    }
    assert!(proxy(&bus, &collection)
        .get::<bool>(COLLECTION, "Locked")
        .unwrap());
    remove_kernel_fixture(
        "collab-replica",
        &format!("{}:vault", collab_replica::server_key(&url)),
    );
}

fn remove_kernel_fixture(service: &str, account: &str) {
    if let Ok(credential) =
        keyring::keyutils::KeyutilsCredential::new_with_target(None, service, account)
    {
        let _ = keyring::Entry::new_with_credential(Box::new(credential)).delete_credential();
    }
}

async fn rotate_during_lock(collection: Path<'static>) {
    use crate::{
        hosted_session::{refresh_session_locked, RefreshMode},
        state::HostedSessionRuntime,
    };
    use httpmock::{HttpMockResponse, MockServer};

    let server = MockServer::start_async().await;
    // Unique fixture namespace even on systems with a user-wide kernel keyring.
    let namespace = uuid::Uuid::new_v4();
    let base = format!("{}/{namespace}", server.base_url());
    let initial = UnlockedCredential::open("collab-server", &base).unwrap();
    initial.write("initial").unwrap();
    let refresh = server.mock_async(|when, then| {
        when.path(format!("/{namespace}/api/v1/auth/refresh")).json_body(serde_json::json!({"refreshToken": "initial"}));
        then.respond_with(move |_| {
            let bus = Connection::new_session().unwrap();
            let (_, prompt): (Vec<Path>, Path) = proxy(&bus, &ROOT.into())
                .method_call(SERVICE, "Lock", (vec![collection.clone()],)).unwrap();
            assert_eq!(&*prompt, "/");
            let body = serde_json::json!({"data": {
                "user": {"id":"1","username":"test","displayName":"Test","role":"member","status":"active",
                         "createdAt":"","activeSessions":1,"isPrimaryAdmin":false},
                "accessToken":"access","refreshToken":"replacement",
                "accessExpiresAt":"2099-01-01T00:00:00Z","refreshExpiresAt":"2099-02-01T00:00:00Z"
            }});
            HttpMockResponse::builder().status(200).body(body.to_string()).build()
        });
    }).await;
    let state = HostedSessionRuntime::new();
    let attempt = || refresh_session_locked(&state, &base, false, true, RefreshMode::Automatic);
    for _ in 0..2 {
        assert_eq!(attempt().await.unwrap().refresh_token, "replacement");
    }
    state
        .server_sessions
        .write()
        .get_mut(&base)
        .unwrap()
        .access_expires_at = "2000-01-01T00:00:00Z".into();
    assert_eq!(attempt().await.unwrap_err(), LOCKED);
    refresh.assert_calls_async(1).await;
    remove_kernel_fixture("collab-server", &base);
}
