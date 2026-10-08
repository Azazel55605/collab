-- Message edits, deletions, replies and reactions. Every visible change bumps a
-- per-conversation revision so clients can fetch changed messages they already
-- hold without re-reading history; new messages keep using sequences.
ALTER TABLE conversations ADD COLUMN revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE conversation_messages
    ADD COLUMN edited_at TIMESTAMPTZ,
    ADD COLUMN deleted_at TIMESTAMPTZ,
    ADD COLUMN reply_to UUID REFERENCES conversation_messages(id) ON DELETE SET NULL,
    ADD COLUMN revision BIGINT NOT NULL DEFAULT 0;
CREATE INDEX conversation_messages_revision_idx
    ON conversation_messages(conversation_id, revision) WHERE revision > 0;
CREATE TABLE conversation_reactions (
    message_id UUID NOT NULL REFERENCES conversation_messages(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL CHECK (char_length(emoji) BETWEEN 1 AND 16),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (message_id, user_id, emoji)
);
