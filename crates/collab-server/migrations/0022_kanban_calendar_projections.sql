CREATE TABLE kanban_calendar_projections (
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vault_id UUID NOT NULL REFERENCES hosted_vaults(id) ON DELETE CASCADE,
    file_id UUID NOT NULL REFERENCES hosted_file_entries(id) ON DELETE CASCADE,
    card_id TEXT NOT NULL,
    calendar_id UUID NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    item_id UUID NOT NULL REFERENCES calendar_items(id) ON DELETE CASCADE,
    source_revision BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, vault_id, file_id, card_id),
    UNIQUE (item_id)
);

CREATE INDEX kanban_calendar_projections_source_idx
    ON kanban_calendar_projections (vault_id, file_id);

CREATE INDEX kanban_calendar_projections_owner_idx
    ON kanban_calendar_projections (owner_id, calendar_id);
