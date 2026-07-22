ALTER TABLE calendars
    ADD COLUMN logical_size_bytes BIGINT NOT NULL DEFAULT 0 CHECK (logical_size_bytes >= 0);

ALTER TABLE calendar_items
    ADD COLUMN logical_size_bytes BIGINT NOT NULL DEFAULT 0 CHECK (logical_size_bytes >= 0);

UPDATE calendars SET logical_size_bytes = octet_length(payload::text);
UPDATE calendar_items SET logical_size_bytes = octet_length(payload::text);

CREATE TABLE calendar_attendees (
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id UUID NOT NULL REFERENCES calendar_items(id) ON DELETE CASCADE,
    attendee_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('collabUser', 'email')),
    collab_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    email TEXT,
    response TEXT NOT NULL,
    role TEXT NOT NULL,
    payload JSONB NOT NULL,
    PRIMARY KEY (item_id, attendee_id)
);

CREATE INDEX calendar_attendees_owner_idx ON calendar_attendees (owner_id, item_id);

CREATE TABLE calendar_invitations (
    id UUID PRIMARY KEY,
    organizer_owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    attendee_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id UUID NOT NULL REFERENCES calendar_items(id) ON DELETE CASCADE,
    attendee_id TEXT NOT NULL,
    response TEXT NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (item_id, attendee_user_id)
);

CREATE INDEX calendar_invitations_attendee_idx
    ON calendar_invitations (attendee_user_id, updated_at DESC);
CREATE INDEX calendar_invitations_organizer_idx
    ON calendar_invitations (organizer_owner_id, item_id);

CREATE TABLE calendar_attachment_uploads (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    calendar_id UUID NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    media_type TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
    content BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX calendar_attachment_uploads_owner_idx
    ON calendar_attachment_uploads (owner_id, calendar_id, created_at DESC);

CREATE TABLE calendar_attachments (
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id UUID NOT NULL REFERENCES calendar_items(id) ON DELETE CASCADE,
    attachment_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('vaultFile', 'kanbanTask', 'uploaded', 'externalUrl')),
    upload_id UUID REFERENCES calendar_attachment_uploads(id) ON DELETE RESTRICT,
    payload JSONB NOT NULL,
    PRIMARY KEY (item_id, attachment_id)
);

CREATE INDEX calendar_attachments_owner_idx ON calendar_attachments (owner_id, item_id);

CREATE TABLE calendar_subscriptions (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    calendar_id UUID NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    feed_url TEXT NOT NULL,
    etag TEXT,
    last_modified TEXT,
    refresh_cursor TEXT,
    last_refreshed_at TIMESTAMPTZ,
    last_error TEXT,
    logical_size_bytes BIGINT NOT NULL DEFAULT 0 CHECK (logical_size_bytes >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (owner_id, feed_url)
);

CREATE INDEX calendar_subscriptions_owner_idx
    ON calendar_subscriptions (owner_id, updated_at DESC);
