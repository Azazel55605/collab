-- `.deck` presentations become a first-class hosted document type.
--
-- Kept in its own migration because PostgreSQL will not let a value added by
-- `ALTER TYPE ... ADD VALUE` be used in the same transaction that added it.
-- The reclassification of existing rows therefore lives in 0032, exactly as
-- the `ink` type did in 0028/0029.
ALTER TYPE hosted_document_type ADD VALUE IF NOT EXISTS 'deck';
