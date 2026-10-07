-- Derived data: keep only the latest thumbnail for each file. Deleting the
-- file/vault removes its cache; revisions and renderer upgrades replace it.
CREATE TABLE hosted_document_previews (
    file_id UUID PRIMARY KEY REFERENCES hosted_file_entries(id) ON DELETE CASCADE,
    content_hash TEXT NOT NULL,
    file_name TEXT NOT NULL,
    renderer_version INTEGER NOT NULL,
    svg TEXT NOT NULL CHECK (octet_length(svg) <= 65536),
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
