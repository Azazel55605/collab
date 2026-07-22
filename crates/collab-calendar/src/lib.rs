//! Shared native calendar domain and profile-scoped SQLite persistence.
//!
//! The store contains calendar data and synchronization metadata only. It never
//! stores hosted access or refresh tokens.

mod models;
mod store;

pub use models::{
    CalendarAttachment, CalendarAttendee, CalendarCleanupResult, CalendarDefinition, CalendarItem,
    CalendarItemKind, CalendarLocation, CalendarMutation, CalendarOperation,
    CalendarOperationFailure, CalendarRecurrence, CalendarReminder, CalendarRemoteChange,
    CalendarSourceBinding, CalendarSyncState, CalendarTimeValue, CALENDAR_SCHEMA_VERSION,
};
pub use store::{
    CalendarStore, CalendarStoreError, LOCAL_STORE_SCHEMA_VERSION, MAX_RANGE_QUERY_ITEMS,
    MAX_SEARCH_QUERY_ITEMS,
};
