#!/usr/bin/env bash
set -euo pipefail

version=${1:-11.4}
case "$version" in
    10.11|11.4) ;;
    *) echo "Usage: $0 [10.11|11.4]" >&2; exit 2 ;;
esac
cd "$(dirname "$0")/.."
# Build before starting the database. Run the selected test executable
# directly so a concurrent Cargo build cannot hold the fixture open.
test_binary=$(
  cargo test --locked -p collab --lib --no-run --message-format=json |
    node --input-type=module -e '
      import { createInterface } from "node:readline";
      for await (const line of createInterface({ input: process.stdin })) {
        const event = JSON.parse(line);
        if (event.reason === "compiler-message" && event.message.rendered)
          process.stderr.write(event.message.rendered);
        if (event.reason === "compiler-artifact" && event.profile.test &&
            event.target.name === "collab_lib" && event.executable)
          process.stdout.write(event.executable);
      }
    '
)
test -x "$test_binary"
work=$(mktemp -d /tmp/collab-phase5-mariadb.XXXXXXXX)
fixture=collab-phase5-mariadb-$$
password=$(openssl rand -hex 24)
root_password=$(openssl rand -hex 24)
image="mariadb:$version"
cleanup() {
    docker rm -f -v "$fixture" >/dev/null 2>&1 || :
    rm -rf "$work"
}
trap cleanup EXIT
mkdir -m 755 "$work/tls" "$work/init"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=Collab-MariaDB-Test-CA -keyout "$work/ca.key" -out "$work/tls/ca.pem" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj /CN=localhost -keyout "$work/tls/server.key" -out "$work/server.csr" >/dev/null 2>&1
printf 'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n' > "$work/ext"
openssl x509 -req -in "$work/server.csr" -CA "$work/tls/ca.pem" -CAkey "$work/ca.key" -CAcreateserial -days 2 -extfile "$work/ext" -out "$work/tls/server.pem" >/dev/null 2>&1
chmod 644 "$work/tls/server.key"
cat > "$work/init/001-fixture.sql" <<SQL
CREATE DATABASE collab_phase5 CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
CREATE USER 'editor'@'%' IDENTIFIED BY '$password' REQUIRE SSL;
CREATE USER 'limited'@'%' IDENTIFIED BY '$password' REQUIRE SSL;
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, LOCK TABLES, TRIGGER ON collab_phase5.* TO 'editor'@'%';
GRANT SELECT, INSERT, UPDATE, DELETE ON collab_phase5.* TO 'limited'@'%';
USE collab_phase5;
CREATE TABLE items (
 id BIGINT UNSIGNED PRIMARY KEY,
 quantity DECIMAL(35,10) DEFAULT 0,
 value VARCHAR(100) NOT NULL,
 payload VARBINARY(100),
 elapsed TIME(6),
 note DATE,
 generated VARCHAR(100) GENERATED ALWAYS AS (UPPER(value)) STORED
) ENGINE=InnoDB;
INSERT INTO items (id,quantity,value,payload,elapsed) VALUES
 (1,1,'First',NULL,NULL),(18446744073709551615,1234567890123456789012345.1234567890,'Second',0x0001,'-100:00:01.123456');
CREATE TABLE nontransactional (id INT PRIMARY KEY) ENGINE=MyISAM;
CREATE TABLE without_key (value VARCHAR(100)) ENGINE=InnoDB;
CREATE TABLE with_trigger (id INT PRIMARY KEY) ENGINE=InnoDB;
CREATE TRIGGER side_effect AFTER INSERT ON with_trigger FOR EACH ROW INSERT INTO nontransactional VALUES (NEW.id);
SQL
MARIADB_ROOT_PASSWORD="$root_password" docker run --detach --name "$fixture" -p 127.0.0.1::3306 \
  --env MARIADB_ROOT_PASSWORD \
  --mount "type=bind,source=$work/tls,target=/fixture/tls,readonly" \
  --mount "type=bind,source=$work/init,target=/docker-entrypoint-initdb.d,readonly" \
  "$image" --sql-mode=ANSI_QUOTES,NO_BACKSLASH_ESCAPES --ssl-ca=/fixture/tls/ca.pem --ssl-cert=/fixture/tls/server.pem --ssl-key=/fixture/tls/server.key --require-secure-transport=ON >/dev/null
for attempt in {1..60}; do
  if MYSQL_PWD="$password" docker exec --env MYSQL_PWD "$fixture" mariadb \
    --protocol=TCP --host=localhost --user=editor --ssl-ca=/fixture/tls/ca.pem \
    --ssl-verify-server-cert --connect-timeout=2 --execute='SELECT 1' collab_phase5 >/dev/null 2>&1; then
    break
  fi
  if (( attempt == 60 )); then
    echo "The disposable MariaDB instance did not become healthy." >&2
    exit 1
  fi
  sleep 1
done
endpoint=$(docker port "$fixture" 3306/tcp)
export COLLAB_MARIA_DISPOSABLE=yes COLLAB_MARIA_FIXTURE_PORT=${endpoint##*:} COLLAB_MARIA_FIXTURE_PASSWORD=$password SSL_CERT_FILE="$work/tls/ca.pem"
"$test_binary" database::maria::tests::disposable_mariadb_verified_queries_metadata_and_atomic_edits --exact --ignored --nocapture
