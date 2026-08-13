-- `.ink` drawings become a first-class hosted document type.
--
-- Kept in its own migration because PostgreSQL will not let a value added by
-- `ALTER TYPE ... ADD VALUE` be used in the same transaction that added it.
-- The reclassification of existing rows therefore lives in 0029, exactly as
-- the `sheet` type did in 0026/0027.
ALTER TYPE hosted_document_type ADD VALUE IF NOT EXISTS 'ink';
