CREATE TABLE calendar_caldav_credentials (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    secret_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

CREATE INDEX calendar_caldav_credentials_owner_idx
    ON calendar_caldav_credentials (owner_id, created_at DESC)
    WHERE revoked_at IS NULL;

CREATE TABLE calendar_caldav_resources (
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    calendar_id UUID NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    resource_name TEXT NOT NULL,
    uid TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, calendar_id, resource_name),
    UNIQUE (owner_id, calendar_id, uid)
);

CREATE INDEX calendar_caldav_resources_calendar_idx
    ON calendar_caldav_resources (owner_id, calendar_id, updated_at DESC);
