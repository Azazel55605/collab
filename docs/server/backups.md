# Server Backups

The self-hosted server stores canonical hosted-vault state in PostgreSQL and
content-addressed payloads in the blob volume. A useful backup must contain
both parts from the same deployment.

## Automated Compose Backups

The default server container can run scheduled backups itself. Open
`/admin/` -> **Backups** -> **Schedule and export** to enable the scheduler,
change the interval, set retention, and configure an export path. These
settings are stored in the backup volume and apply to both scheduled backups
and the **Run backup** button.

`.env` values are global overrides. If one of these variables is present in the
container environment, the matching admin UI field is locked until the variable
is removed and the container is restarted:

```dotenv
COLLAB_BACKUP_SCHEDULE_ENABLED=true
COLLAB_BACKUP_INTERVAL_SECONDS=86400
COLLAB_BACKUP_RETENTION_DAYS=14
```

`COLLAB_BACKUP_INTERVAL_SECONDS` controls how often a full deployment backup is
created. `COLLAB_BACKUP_RETENTION_DAYS=0` disables automatic pruning.

The admin web Backups page shows whether the scheduler is enabled, the interval,
retention, and the external export target status.

An optional `backup` profile is still available for operators who prefer a
separate worker container. It runs the same backup helper into the shared
`backups` volume.

Simple command:

```bash
pnpm server:backup:schedule
```

Equivalent Compose command:

```bash
docker compose --profile backup up -d backup
```

Each backup directory is named `collab-backup-<UTC timestamp>` and contains:

- `postgres.dump`: PostgreSQL custom-format dump.
- `blobs.tar.gz`: archive of the content-addressed blob directory.
- `manifest.txt`: backup metadata.
- `config.env`: sanitized non-secret server configuration values.
- `checksums.sha256`: SHA-256 checksums for the backup artifacts.

The PostgreSQL dump includes CalDAV resource mappings and app-password hashes.
Raw CalDAV app passwords are intentionally unrecoverable and must be replaced
if lost; restoring their hashes preserves credentials that clients still hold.

## Manual Backup

Run one backup immediately:

```bash
pnpm server:backup
```

Equivalent script:

```bash
./scripts/server-backup.sh
```

Or run the backup worker directly:

```bash
docker compose run --rm backup /usr/local/bin/collab-backup
```

List and verify backups:

```bash
pnpm server:backup:list
pnpm server:backups verify collab-backup-20260618T111501Z
```

For all simple backup commands:

```bash
pnpm server:backups help
```

## Admin UI Integration

The admin web interface includes a Backups page. It can always list backup
directories visible to the server, verify `checksums.sha256`, and delete old
backup directories.

In the default Docker Compose deployment, the Backups page can also run a
backup and restore a selected backup. Compose wires the server container to the
same backup helpers used by the command line:

```dotenv
COLLAB_BACKUP_COMMAND=/usr/local/bin/collab-backup
COLLAB_RESTORE_COMMAND=/usr/local/bin/collab-admin-restore
```

The admin restore wrapper verifies and restores the selected backup, then
terminates the server process so Docker Compose restarts it against the
restored database.

To disable admin-UI execution while still allowing listing, verification, and
deletion, set the command hooks to empty values:

```dotenv
COLLAB_BACKUP_COMMAND=
COLLAB_RESTORE_COMMAND=
```

Advanced operators can replace either value with a custom command. Use this for
orchestration that also snapshots host volumes, pauses external traffic, ships
artifacts off-host, or delegates restores to a separate automation system.

When `COLLAB_RESTORE_COMMAND` runs, the server sets
`COLLAB_RESTORE_BACKUP=<backup name>` and `COLLAB_BACKUP_DIR=<backup root>` in
the command environment.

## Portable Backup Import and Export

Each completed backup can be exported from the Backups page as a portable
`<backup-name>.tar.gz` archive. Export verifies the backup checksums and the
backup manifest version before streaming the archive, so incomplete or corrupt
backup directories are not offered as migration artifacts.

The Backups page can also import a previously exported archive. Import performs
these checks before publishing the backup into the server backup volume:

- The archive must contain exactly one top-level `collab-backup-*` directory.
- Archive paths must be relative and must not contain traversal components.
- Required artifacts must exist: `postgres.dump`, `blobs.tar.gz`,
  `manifest.txt`, `config.env`, and `checksums.sha256`.
- `manifest.txt` must declare `collab_backup_version=1`.
- `checksums.sha256` must verify successfully.
- A backup with the same name must not already exist on the target server.

After import, use **Verify** once more if desired, then restore through the
normal restore flow. Restoring remains a destructive operator action and still
requires `COLLAB_RESTORE_COMMAND` to be configured.

## External Export Target

Backups are always written to the internal Compose `backups` volume first. To
also copy each completed backup to external storage, mount that storage on the
Docker host and bind it into the containers.

Example host mount plus GUI/export setup for SMB, NFS, or USB:

```dotenv
COLLAB_BACKUP_EXPORT_PATH=/mnt/collab-backups
```

`COLLAB_BACKUP_EXPORT_PATH` is the host path. It can be a local folder, a USB
drive mount, an SMB mount, or an NFS mount. After restarting Compose, set the
admin UI **Container export path** field to `/backup-export`.

The Backups page shows whether the export target is configured and writable.
If it is configured but not writable, backup creation fails instead of silently
leaving the external copy behind.

## Copy Backups Off Host

The Compose volume protects against container replacement, not host loss. Copy
completed backup directories to storage outside the server host and protect
them with the same care as production data.

Example inspection command:

```bash
docker compose exec collab-server ls -la /backups
```

## Backup Verification Test

Run the disposable backup/restore smoke test:

```bash
./scripts/server-backup-restore-smoke.sh
```

The script uses an isolated Compose project (`collab-restore-smoke` by
default), creates a small PostgreSQL table plus blob payload, backs them up,
verifies `checksums.sha256`, deliberately changes both values, restores the
backup, and asserts the original database row and blob payload returned.

## Full Deployment Restore

A full restore replaces the PostgreSQL schema and the blob volume with the
contents of one backup. It is destructive. Keep an off-host copy of the current
deployment before starting.

1. Identify the backup directory:

   ```bash
   docker compose exec collab-server ls -la /backups
   ```

2. Restore the backup:

   ```bash
   pnpm server:restore collab-backup-20260618T111501Z
   ```

   The simple command asks you to type `restore` before it performs the
   destructive operation.

   Equivalent operator script:

   ```bash
   COLLAB_RESTORE_CONFIRM=restore \
     ./scripts/server-restore.sh collab-backup-20260618T111501Z
   ```

   The script stops `gateway`, `collab-server`, and the optional `backup`
   worker before restoring. It verifies `checksums.sha256`, drops and recreates
   the PostgreSQL `public` schema, restores `postgres.dump`, replaces
   `/data/blobs` from `blobs.tar.gz`, and then restarts the normal Compose
   services.

   Set `COLLAB_RESTORE_NO_RESTART=1` when restoring into an inspection
   environment where the server should stay stopped afterward.

3. Verify the restored deployment:

   ```bash
   curl --fail --silent http://127.0.0.1:${COLLAB_HTTP_PORT:-8788}/health/ready
   curl --fail --silent http://127.0.0.1:${COLLAB_HTTP_PORT:-8788}/api/v1/auth/bootstrap-status
   ```

4. Sign in to `/admin/`, inspect the health dashboard, and open a representative
   hosted vault from the native app.

The restore helper stores a best-effort safety archive of the pre-restore blob
directory under `/backups/restore-safety/` before replacing blobs. PostgreSQL
is not safety-copied by the restore script; make an explicit backup first if
the current database might contain data you need.

To run the container restore command directly:

```bash
COLLAB_RESTORE_CONFIRM=restore \
  docker compose run --rm restore /usr/local/bin/collab-restore /backups/collab-backup-20260618T111501Z
```

This direct restore helper is still useful for offline operator work. The admin
UI uses `/usr/local/bin/collab-admin-restore` inside the running server
container instead, so it can return a result to the browser and then restart
the server container.

## Per-Vault Restore

There are two supported per-vault recovery paths.

### Restore From The Current Deployment

Use this when the server is healthy and the vault still exists.

- Deleted files: open the vault Trash section and restore the item.
- Older document content: use revision history or snapshots and restore as a
  new revision.
- Whole-vault copy: use the admin vault detail view to download a ZIP export,
  create a new hosted vault, and import the ZIP into that empty vault.

This path preserves the rest of the deployment and avoids rewriting global
users, sessions, audit logs, and other vaults.

### Restore One Vault From An Older Full Backup

Use this when a vault was permanently damaged or force-deleted and the only
good copy is inside a full deployment backup.

1. Restore the old backup into a separate staging environment. Do not restore it
   over the production deployment.
2. Sign in to the staging admin UI.
3. Open the affected vault and download its hosted-vault ZIP export.
4. In production, create a new empty hosted vault and import that ZIP.
5. Recreate membership and fine-grained permission grants intentionally. ZIP
   exports contain active vault content, not production users, sessions, audit
   records, deleted vault metadata, or runtime state.
6. Ask users to reopen or switch to the restored vault.

The current per-vault restore model is content-level restore through
export/import. It does not surgically merge old PostgreSQL rows into a running
production database, because doing so would risk breaking stable file IDs,
revision references, CRDT state, audit chains, and permission relationships.

## Consistency Notes

The backup job writes the PostgreSQL dump first and archives blobs afterward.
Server writes store blob bytes before committing metadata, so the blob archive
may contain extra unreferenced blobs from concurrent writes but should not miss
blobs referenced by the database snapshot.

Keep this smoke test in the release gate before trusting backup changes.
