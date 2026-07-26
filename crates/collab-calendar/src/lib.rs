//! Shared native calendar domain and profile-scoped SQLite persistence.
//!
//! The store contains calendar data and synchronization metadata only. It never
//! stores hosted access or refresh tokens.

mod ics;
mod ics_parse;
mod models;
mod store;

pub use ics::export_ics;
pub use ics_parse::{
    parse_ics, IcsParseError, ParsedIcsCalendar, MAX_ICS_BYTES, MAX_ICS_ITEMS, MAX_ICS_LINE_LENGTH,
};
pub use models::{
    CalendarAttachment, CalendarAttendee, CalendarCleanupResult, CalendarDefinition,
    CalendarEventLocation, CalendarItem, CalendarItemKind, CalendarLocation, CalendarMirrorAnchor,
    CalendarMirrorConflict, CalendarMirrorConflictVersion, CalendarMirrorGroup,
    CalendarMirrorMember, CalendarMutation, CalendarOperation, CalendarOperationFailure,
    CalendarRecurrence, CalendarReminder, CalendarRemoteChange, CalendarSourceBinding,
    CalendarSubscription, CalendarSyncState, CalendarTimeValue, CALENDAR_SCHEMA_VERSION,
    MAX_ICALENDAR_PROPERTIES, MAX_ICALENDAR_PROPERTY_LENGTH,
};
pub use store::{
    CalendarStore, CalendarStoreError, LOCAL_STORE_SCHEMA_VERSION, MAX_RANGE_QUERY_ITEMS,
    MAX_SEARCH_QUERY_ITEMS,
};
