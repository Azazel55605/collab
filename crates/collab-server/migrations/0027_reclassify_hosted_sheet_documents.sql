UPDATE hosted_file_entries
SET document_type = 'sheet'::hosted_document_type
WHERE kind = 'document'
  AND document_type = 'note'
  AND LOWER(name) LIKE '%.sheet';
