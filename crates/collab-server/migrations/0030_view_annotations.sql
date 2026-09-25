-- Anchored annotation sidecars for immutable image and review surfaces.
CREATE TABLE hosted_view_annotations (
    vault_id UUID NOT NULL REFERENCES hosted_vaults(id) ON DELETE CASCADE,
    file_id UUID NOT NULL REFERENCES hosted_file_entries(id) ON DELETE CASCADE,
    state JSONB NOT NULL,
    sequence BIGINT NOT NULL DEFAULT 0,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (vault_id, file_id)
);

UPDATE permission_templates
SET capabilities = capabilities || ARRAY['view.annotate']
WHERE is_builtin
  AND name IN ('editor', 'admin')
  AND NOT (capabilities @> ARRAY['view.annotate']);
