ALTER TABLE calendar_items
    DROP CONSTRAINT IF EXISTS calendar_items_calendar_id_uid_key;

ALTER TABLE calendar_items
    ADD COLUMN IF NOT EXISTS recurrence_id TEXT,
    ADD COLUMN IF NOT EXISTS recurrence_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS recurrence_date DATE,
    ADD COLUMN IF NOT EXISTS recurrence_series_id UUID;

CREATE UNIQUE INDEX IF NOT EXISTS calendar_items_uid_recurrence_idx
    ON calendar_items (calendar_id, uid, COALESCE(recurrence_id, ''));

CREATE INDEX IF NOT EXISTS calendar_items_recurrence_at_idx
    ON calendar_items (owner_id, recurrence_at) WHERE recurrence_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS calendar_items_recurrence_date_idx
    ON calendar_items (owner_id, recurrence_date) WHERE recurrence_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS calendar_items_recurrence_series_idx
    ON calendar_items (owner_id, recurrence_series_id) WHERE recurrence_series_id IS NOT NULL;
