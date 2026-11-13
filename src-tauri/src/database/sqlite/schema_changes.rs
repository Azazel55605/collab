use super::{classify, Connection, Session};
use crate::database::schema::{stamp, Change, Outcome, Pending, Preview, Request};
use collab_database::{ContractError as E, Engine};
use rusqlite::{params, OptionalExtension, TransactionBehavior};

impl Session {
    pub(in crate::database) fn schema_preview(&self, request: Request) -> Result<Preview, E> {
        if self.view.read_only {
            return Err(E::DatabaseReadOnly);
        }
        let sql = request.sql(Engine::Sqlite, "main")?;
        let version = self.inspect(|client| inspect(client, &request))?;
        Ok(self
            .schema_draft
            .store(request, sql, version, Engine::Sqlite))
    }

    pub(in crate::database) fn schema_apply(&self, pending: Pending) -> Outcome {
        let result = self.inspect(|client| {
            if self.view.read_only {
                return Err(E::DatabaseReadOnly);
            }
            if !client.is_autocommit() {
                return Err(E::UnresolvedSession);
            }
            let transaction = client
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(classify)?;
            if inspect(&transaction, &pending.request)? != pending.stamp {
                return Err(E::SchemaConflict);
            }
            self.check_identity()?;
            let ddl = transaction
                .execute_batch(&pending.preview.sql)
                .map_err(|error| {
                    if error.sqlite_error_code() == Some(rusqlite::ErrorCode::Unknown)
                        && matches!(
                            pending.request.change,
                            Change::DropColumn { .. } | Change::RenameColumn { .. }
                        )
                    {
                        E::SchemaDependency
                    } else {
                        classify(error)
                    }
                });
            if let Err(code) = ddl {
                return Ok(match transaction.finish() {
                    Ok(()) => Outcome::rejected(code),
                    Err(_) => Outcome::unknown(code),
                });
            }
            if let Err(code) = self.check_identity() {
                return Ok(match transaction.finish() {
                    Ok(()) => Outcome::rejected(code),
                    Err(_) => Outcome::unknown(code),
                });
            }
            Ok(match transaction.commit() {
                Ok(()) => Outcome::Applied,
                Err(error) => Outcome::unknown(classify(error)),
            })
        });
        let result = result.unwrap_or_else(Outcome::rejected);
        match result {
            Outcome::Applied => {
                self.snapshot.lock().take();
            }
            Outcome::Unknown { .. } => {
                self.edit_unknown
                    .store(true, std::sync::atomic::Ordering::Release);
                self.snapshot.lock().take();
                self.connection.lock().take();
            }
            _ => {}
        }
        result
    }
}

fn inspect(client: &Connection, request: &Request) -> Result<[u8; 32], E> {
    let version: i64 = client
        .query_row("PRAGMA main.schema_version", [], |row| row.get(0))
        .map_err(classify)?;
    let object: Option<(String, String)> = client.query_row(
        "SELECT type,name FROM main.sqlite_schema WHERE name=?1 COLLATE NOCASE AND type IN ('table','view','index')",
        [&request.table], |row| Ok((row.get(0)?,row.get(1)?)),
    ).optional().map_err(classify)?;
    if request.create() {
        if object.is_some() {
            return Err(E::SchemaConflict);
        }
        return Ok(stamp(version.to_le_bytes()));
    }
    let Some((kind, table)) = object else {
        return Err(E::SchemaConflict);
    };
    if kind != "table" {
        return Err(E::SchemaDependency);
    }
    let ordinary: bool = client.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_list WHERE schema='main' AND name=?1 AND type='table')",
        [&table], |row| row.get(0),
    ).map_err(classify)?;
    if !ordinary {
        return Err(E::SchemaDependency);
    }

    if let Change::DropColumn { column } = &request.change {
        let pages: i64 = client
            .query_row("PRAGMA main.page_count", [], |row| row.get(0))
            .map_err(classify)?;
        let size: i64 = client
            .query_row("PRAGMA main.page_size", [], |row| row.get(0))
            .map_err(classify)?;
        if pages.saturating_mul(size) > 64 << 20 {
            return Err(E::LimitReached);
        }
        // ALTER DROP rewrites table records and reparses dependencies. Reject
        // foreign keys up front because nullable REFERENCES clauses can
        // otherwise be removed along with the column.
        let foreign_keys: bool = client.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_list AS t JOIN pragma_foreign_key_list(t.name,'main') AS f
               WHERE t.schema='main' AND t.type='table' AND
               (t.name=?1 COLLATE NOCASE OR f.[table]=?1 COLLATE NOCASE))",
            [&table], |row| row.get(0),
        ).map_err(classify)?;
        let eligible: bool = client.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_xinfo(?1,'main') WHERE name=?2 COLLATE NOCASE AND pk=0 AND hidden=0 AND dflt_value IS NULL AND [notnull]=0)",
            params![table,column], |row| row.get(0),
        ).map_err(classify)?;
        let dependent: bool = client.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_index_list(?1,'main') i
               JOIN pragma_index_xinfo(i.name,'main') c WHERE c.name=?2 COLLATE NOCASE)
             OR EXISTS(SELECT 1 FROM main.sqlite_schema WHERE type IN ('view','trigger'))
             OR EXISTS(SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name=?1 COLLATE NOCASE AND instr(upper(sql),'CHECK')>0)",
            params![table,column], |row| row.get(0),
        ).map_err(classify)?;
        if foreign_keys || dependent || !eligible {
            return Err(E::SchemaDependency);
        }
    }
    Ok(stamp(version.to_le_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::sqlite::tests::open;
    use crate::database::sqlite::OpenMode;

    fn request(change: &str) -> Request {
        serde_json::from_str(&format!(
            r#"{{"schema":"main","table":"items","change":{change}}}"#
        ))
        .unwrap()
    }

    fn apply(file: &Session, request: Request, confirm_loss: bool) -> Outcome {
        let preview = file.schema_preview(request).unwrap();
        file.schema_apply(file.schema_draft.take(&preview.id, confirm_loss).unwrap())
    }

    #[test]
    fn schema_rewrite_preserves_rows_and_unrelated_indexes_and_requires_confirmation() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("schema.sqlite");
        let file = open(&path, OpenMode::Create).unwrap();
        assert!(matches!(
            apply(
                &file,
                request(
                    r#"{"kind":"create_table","columns":[{"name":"id","data_type":"integer","primary_key":true,"nullable":false},{"name":"note","data_type":"text","primary_key":false,"nullable":true}]}"#
                ),
                false
            ),
            Outcome::Applied
        ));
        file.inspect(|client| {
            client
                .execute_batch(
                    "INSERT INTO items VALUES (1,'keep'); CREATE INDEX item_note ON items(note)",
                )
                .map_err(classify)
        })
        .unwrap();
        assert!(matches!(
            apply(
                &file,
                request(
                    r#"{"kind":"add_column","column":{"name":"obsolete","data_type":"text","primary_key":false,"nullable":true}}"#
                ),
                false
            ),
            Outcome::Applied
        ));
        file.inspect(|client| {
            client
                .execute_batch("UPDATE items SET obsolete='discard'")
                .map_err(classify)
        })
        .unwrap();
        let preview = file
            .schema_preview(request(r#"{"kind":"drop_column","column":"obsolete"}"#))
            .unwrap();
        assert!(preview.destructive);
        assert_eq!(
            file.schema_draft.take(&preview.id, false).err(),
            Some(E::InvalidParameter)
        );
        assert!(matches!(
            file.schema_apply(file.schema_draft.take(&preview.id, true).unwrap()),
            Outcome::Applied
        ));
        assert_eq!(
            file.schema_draft.take(&preview.id, true).err(),
            Some(E::SchemaConflict)
        );
        assert_eq!(
            file.inspect(|client| client
                .query_row(
                    "SELECT note FROM items INDEXED BY item_note WHERE id=1",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .map_err(classify))
                .unwrap(),
            "keep"
        );
        assert_eq!(
            file.schema_preview(request(r#"{"kind":"drop_column","column":"note"}"#))
                .err(),
            Some(E::SchemaDependency)
        );
    }

    #[test]
    fn schema_apply_rejects_stale_previews_and_preserves_dependent_views() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("schema.sqlite");
        let file = open(&path, OpenMode::Create).unwrap();
        file.inspect(|client| client.execute_batch("CREATE TABLE items(id INTEGER PRIMARY KEY, note TEXT); CREATE VIEW v AS SELECT note FROM items; INSERT INTO items VALUES (1,'keep')").map_err(classify)).unwrap();
        assert_eq!(
            file.schema_preview(request(r#"{"kind":"drop_column","column":"note"}"#))
                .err(),
            Some(E::SchemaDependency)
        );
        let preview = file
            .schema_preview(request(
                r#"{"kind":"rename_column","column":"note","name":"description"}"#,
            ))
            .unwrap();
        Connection::open(&path)
            .unwrap()
            .execute_batch("CREATE INDEX item_id ON items(id)")
            .unwrap();
        assert!(
            matches!(file.schema_apply(file.schema_draft.take(&preview.id,false).unwrap()), Outcome::Rejected { failure } if failure.code == E::SchemaConflict)
        );
        assert!(matches!(
            apply(
                &file,
                request(r#"{"kind":"rename_column","column":"note","name":"description"}"#),
                false
            ),
            Outcome::Applied
        ));
        assert_eq!(
            file.inspect(|client| client
                .query_row("SELECT description FROM v", [], |row| row
                    .get::<_, String>(0))
                .map_err(classify))
                .unwrap(),
            "keep"
        );
    }
}
