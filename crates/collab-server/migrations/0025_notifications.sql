CREATE TABLE notification_devices (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    installation_id TEXT NOT NULL,
    platform TEXT NOT NULL CHECK (platform IN ('android')),
    provider TEXT NOT NULL CHECK (provider IN ('fcm')),
    token TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    account_key TEXT NOT NULL,
    app_version TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, installation_id, provider),
    UNIQUE (provider, token_hash),
    UNIQUE (account_key)
);

CREATE INDEX notification_devices_user_idx
    ON notification_devices (user_id, active, updated_at DESC);

CREATE TABLE notification_events (
    sequence BIGSERIAL PRIMARY KEY,
    id UUID NOT NULL UNIQUE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category TEXT NOT NULL CHECK (
        category IN (
            'calendar.invitation',
            'collaboration.message',
            'collaboration.mention',
            'sync.action-required'
        )
    ),
    dedupe_key TEXT NOT NULL,
    envelope JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '90 days'),
    UNIQUE (user_id, dedupe_key)
);

CREATE INDEX notification_events_user_cursor_idx
    ON notification_events (user_id, sequence);
CREATE INDEX notification_events_expiry_idx
    ON notification_events (expires_at);

CREATE TABLE notification_push_deliveries (
    event_id UUID NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
    device_id UUID NOT NULL REFERENCES notification_devices(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (
        state IN ('pending', 'sending', 'delivered', 'failed', 'cancelled')
    ),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_until TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (event_id, device_id)
);

CREATE INDEX notification_push_deliveries_due_idx
    ON notification_push_deliveries (state, next_attempt_at);
