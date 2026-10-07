-- Personal conversations have no vault dependency. Pair UUIDs intentionally
-- survive account deletion; membership cascades and sender identity is nulled.
CREATE TABLE conversations (
    id UUID PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
    name TEXT NOT NULL DEFAULT '',
    pair_low UUID,
    pair_high UUID,
    picture TEXT,
    head BIGINT NOT NULL DEFAULT 0,
    updated_cursor BIGINT NOT NULL DEFAULT 0,
    CHECK ((kind='direct' AND pair_low IS NOT NULL AND pair_high IS NOT NULL AND pair_low < pair_high) OR
           (kind='group' AND pair_low IS NULL AND pair_high IS NULL)),
    UNIQUE (pair_low, pair_high)
);
CREATE TABLE conversation_members (
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner','member')),
    joined_sequence BIGINT NOT NULL,
    joined_event BIGINT NOT NULL,
    read_sequence BIGINT NOT NULL,
    PRIMARY KEY (conversation_id,user_id)
);
CREATE INDEX conversation_members_user_idx ON conversation_members(user_id,conversation_id);
CREATE TABLE conversation_messages (
    id UUID PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    content TEXT NOT NULL,
    sequence BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (conversation_id,sequence)
);
CREATE TABLE conversation_events (
    sequence BIGSERIAL PRIMARY KEY,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('created','message','members','updated','read','removed')),
    recipients UUID[] NOT NULL
);
CREATE INDEX conversation_events_recipients_idx ON conversation_events USING GIN(recipients);

-- Also protect ownership from administrator account disable/delete and direct
-- SQL writes. The same transaction lock orders mutation/event commits.
CREATE FUNCTION protect_conversation_owner() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.status = 'active' THEN RETURN NEW; END IF;
    PERFORM pg_advisory_xact_lock(3602026);
    IF EXISTS (
        SELECT 1 FROM conversation_members m JOIN conversations c ON c.id=m.conversation_id
        WHERE m.user_id=OLD.id AND m.role='owner' AND c.kind='group'
          AND NOT EXISTS (SELECT 1 FROM conversation_members other JOIN users u ON u.id=other.user_id
              WHERE other.conversation_id=m.conversation_id AND other.user_id<>OLD.id
                AND other.role='owner' AND u.status='active')
    ) THEN RAISE EXCEPTION 'Transfer group conversation ownership before disabling or deleting this account.'; END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER conversation_owner_account_guard BEFORE DELETE OR UPDATE OF status ON users
FOR EACH ROW EXECUTE FUNCTION protect_conversation_owner();
