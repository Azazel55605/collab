-- Preserve deterministic historical ordering, then allocate append-only cursors.
CREATE SEQUENCE hosted_chat_message_sequence;
ALTER TABLE hosted_chat_messages ADD COLUMN sequence BIGINT;
WITH ordered AS (
    SELECT id, row_number() OVER (ORDER BY created_at, id) AS position
    FROM hosted_chat_messages
)
UPDATE hosted_chat_messages m SET sequence = ordered.position FROM ordered WHERE m.id = ordered.id;
SELECT setval('hosted_chat_message_sequence',
    COALESCE((SELECT MAX(sequence) FROM hosted_chat_messages), 0) + 1, false);
ALTER TABLE hosted_chat_messages ALTER COLUMN sequence SET NOT NULL;
ALTER TABLE hosted_chat_messages ALTER COLUMN sequence SET DEFAULT nextval('hosted_chat_message_sequence');
ALTER SEQUENCE hosted_chat_message_sequence OWNED BY hosted_chat_messages.sequence;
CREATE UNIQUE INDEX hosted_chat_messages_cursor_idx ON hosted_chat_messages(vault_id, sequence);

-- Existing built-in writers retain chat; custom grants opt in explicitly.
UPDATE permission_templates
SET capabilities = array_append(capabilities, 'chat.send')
WHERE is_builtin AND name IN ('editor', 'admin') AND NOT ('chat.send' = ANY(capabilities));
