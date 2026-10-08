-- Teams are independent of server administrative permission groups.
CREATE TABLE teams (
 id UUID PRIMARY KEY, name TEXT NOT NULL, archived BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE team_members (
 team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
 user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK(role IN ('owner','member')),
 PRIMARY KEY(team_id,user_id)
);
CREATE INDEX team_members_user_idx ON team_members(user_id,team_id);
ALTER TABLE conversations DROP CONSTRAINT conversations_kind_check;
ALTER TABLE conversations DROP CONSTRAINT conversations_check;
ALTER TABLE conversations ADD CHECK(kind IN ('direct','group','channel'));
ALTER TABLE conversations ADD CHECK((kind='direct' AND pair_low IS NOT NULL AND pair_high IS NOT NULL AND pair_low<pair_high) OR (kind IN ('group','channel') AND pair_low IS NULL AND pair_high IS NULL));
CREATE TABLE team_channels (
 conversation_id UUID PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
 team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
 private BOOLEAN NOT NULL DEFAULT FALSE,
 archived BOOLEAN NOT NULL DEFAULT FALSE,
 library_vault_id UUID UNIQUE REFERENCES hosted_vaults(id) ON DELETE RESTRICT
);
CREATE INDEX team_channels_team_idx ON team_channels(team_id);
-- Linked vaults retain their custodian and existing grants. The channel is an
-- additional authorization boundary, never a replacement for file permissions.
CREATE FUNCTION protect_team_owner() RETURNS trigger AS $$
BEGIN
 IF TG_OP='UPDATE' AND NEW.status='active' THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(3602026);
 IF EXISTS(SELECT 1 FROM team_members m WHERE m.user_id=OLD.id AND m.role='owner'
   AND NOT EXISTS(SELECT 1 FROM team_members other JOIN users u ON u.id=other.user_id
    WHERE other.team_id=m.team_id AND other.user_id<>OLD.id AND other.role='owner' AND u.status='active'))
 OR EXISTS(SELECT 1 FROM team_channels ch JOIN conversation_members m ON m.conversation_id=ch.conversation_id WHERE ch.private AND m.user_id=OLD.id AND m.role='owner'
 AND NOT EXISTS(SELECT 1 FROM conversation_members other JOIN users u ON u.id=other.user_id WHERE other.conversation_id=ch.conversation_id AND other.user_id<>OLD.id AND other.role='owner' AND u.status='active'))
 THEN RAISE EXCEPTION 'Transfer team ownership before disabling or deleting this account.'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER team_owner_account_guard BEFORE DELETE OR UPDATE OF status ON users
 FOR EACH ROW EXECUTE FUNCTION protect_team_owner();
