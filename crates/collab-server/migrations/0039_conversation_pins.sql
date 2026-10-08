-- Per-member pins for chats, groups, channels and teams. Pins belong to the
-- membership row, so they disappear with it and sync across the user's devices.
ALTER TABLE conversation_members ADD COLUMN pinned_at TIMESTAMPTZ;
ALTER TABLE team_members ADD COLUMN pinned_at TIMESTAMPTZ;
CREATE INDEX conversation_members_pinned_idx
    ON conversation_members(user_id) WHERE pinned_at IS NOT NULL;
