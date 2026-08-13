-- Drawings uploaded before `ink` existed were stored as notes. Reclassify them
-- so reference collection, validation, and live materialization pick the right
-- document domain for them.
UPDATE hosted_file_entries
SET document_type = 'ink'::hosted_document_type
WHERE kind = 'document'
  AND document_type = 'note'
  AND LOWER(name) LIKE '%.ink';
