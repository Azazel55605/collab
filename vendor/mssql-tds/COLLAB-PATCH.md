# Collab diagnostic retention patch

Source: published Microsoft `mssql-tds` 0.4.0, MIT. No SQL parser or wire-format changes. `TdsClient::set_info_message_limits` opts a client into
bounded INFO retention (count, aggregate bytes, 4 KiB text); the same configured
limits stop ERROR accumulation before result walkers retain diagnostics. Exceeding
the ERROR limit uses the existing encoded-size error and retires the transport. `take_info_messages_truncated`
reports truncation, including an ERROR-limit failure masked by upstream batch draining. Server/procedure names are omitted from capped INFO entries.
Defaults remain upstream behavior for other callers. Collab enables 256 messages /
64 KiB on each client before executing SQL and stops results explicitly when the
buffer was truncated. The application still caps its complete result stream. The `execute` and
`execute_sp_executesql` tracing spans skip SQL text, in addition to parameter
values already skipped upstream.

Remove this local patch when a released driver provides equivalent admission.
The separate Phase 0 comparison workspace continues to use the published release.
