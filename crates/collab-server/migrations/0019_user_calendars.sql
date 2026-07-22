CREATE TABLE calendars (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    global_id UUID NOT NULL,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    default_time_zone TEXT NOT NULL,
    archived BOOLEAN NOT NULL DEFAULT FALSE,
    read_only BOOLEAN NOT NULL DEFAULT FALSE,
    revision BIGINT NOT NULL DEFAULT 1,
    payload JSONB NOT NULL,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (owner_id, global_id)
);

CREATE INDEX calendars_owner_updated_idx
    ON calendars (owner_id, archived, updated_at DESC);

CREATE TABLE calendar_items (
    id UUID PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    calendar_id UUID NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    uid TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('event', 'task', 'birthday')),
    start_at TIMESTAMPTZ,
    end_at TIMESTAMPTZ,
    start_date DATE,
    end_date DATE,
    recurrence_rule TEXT,
    revision BIGINT NOT NULL DEFAULT 1,
    payload JSONB NOT NULL,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (calendar_id, uid)
);

CREATE INDEX calendar_items_owner_range_idx
    ON calendar_items (owner_id, start_at, end_at) WHERE deleted_at IS NULL;
CREATE INDEX calendar_items_owner_date_range_idx
    ON calendar_items (owner_id, start_date, end_date) WHERE deleted_at IS NULL;
CREATE INDEX calendar_items_calendar_updated_idx
    ON calendar_items (calendar_id, updated_at DESC);

CREATE TABLE calendar_change_log (
    sequence BIGSERIAL PRIMARY KEY,
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('calendar', 'item')),
    entity_id UUID NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
    payload JSONB,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX calendar_change_log_owner_sequence_idx
    ON calendar_change_log (owner_id, sequence);

CREATE TABLE calendar_client_operations (
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_operation_id TEXT NOT NULL,
    result JSONB NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, client_operation_id)
);
