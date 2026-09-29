-- Presentations uploaded before `deck` existed were stored as notes. Reclassify
-- them so reference collection and validation pick the right document domain.
UPDATE hosted_file_entries
SET document_type = 'deck'::hosted_document_type
WHERE kind = 'document'
  AND document_type = 'note'
  AND LOWER(name) LIKE '%.deck';
