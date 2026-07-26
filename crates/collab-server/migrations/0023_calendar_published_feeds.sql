CREATE TABLE calendar_published_feeds (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    calendar_id UUID NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_accessed_at TIMESTAMPTZ
);

CREATE INDEX calendar_published_feeds_owner_calendar_idx
    ON calendar_published_feeds (owner_id, calendar_id, created_at DESC);
