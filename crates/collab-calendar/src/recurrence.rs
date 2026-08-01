use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Duration, NaiveDate, SecondsFormat, Utc};
use rrule::{RRule, Tz, Unvalidated};
use thiserror::Error;

use crate::{CalendarItem, CalendarItemKind, CalendarTimeValue};

pub const MAX_CALENDAR_EXPANDED_CANDIDATES: usize = 20_000;
const MAX_RECURRENCE_RESULTS: u16 = 20_000;

#[derive(Debug, Clone, Copy)]
pub struct CalendarQueryRange {
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub limit: usize,
    pub include_deleted: bool,
    pub include_unscheduled_tasks: bool,
}

#[derive(Debug, Error)]
pub enum CalendarQueryError {
    #[error("calendar query end must be after its start")]
    InvalidRange,
    #[error("calendar query limit must be between 1 and {MAX_CALENDAR_EXPANDED_CANDIDATES}")]
    InvalidLimit,
    #[error("invalid calendar date '{0}'")]
    InvalidDate(String),
    #[error("invalid calendar date-time '{0}'")]
    InvalidDateTime(String),
    #[error("invalid calendar time zone '{0}'")]
    InvalidTimeZone(String),
    #[error("invalid recurrence rule: {0}")]
    InvalidRecurrence(String),
}

#[derive(Debug)]
struct RangedItem {
    item: CalendarItem,
    range: Option<(DateTime<Utc>, DateTime<Utc>)>,
}

pub fn query_calendar_items(
    items: &[CalendarItem],
    query: CalendarQueryRange,
) -> Result<Vec<CalendarItem>, CalendarQueryError> {
    if query.to <= query.from {
        return Err(CalendarQueryError::InvalidRange);
    }
    if query.limit == 0 || query.limit > MAX_CALENDAR_EXPANDED_CANDIDATES {
        return Err(CalendarQueryError::InvalidLimit);
    }

    let masters = items
        .iter()
        .filter(|item| item.recurrence.is_some() && item.recurrence_id.is_none())
        .map(|item| (item.id.as_str(), item))
        .collect::<HashMap<_, _>>();
    let mut active_exception_ids = HashSet::new();
    for item in items.iter().filter(|item| item.recurrence_id.is_some()) {
        let remains_in_series = match item
            .recurrence_series_id
            .as_deref()
            .and_then(|id| masters.get(id).copied())
        {
            Some(master) if master.deleted_at.is_some() => false,
            Some(master) => recurrence_includes(master, item.recurrence_id.as_ref().unwrap())?,
            None => true,
        };
        if remains_in_series {
            active_exception_ids.insert(item.id.as_str());
        }
    }
    let exception_keys = items
        .iter()
        .filter(|item| active_exception_ids.contains(item.id.as_str()))
        .filter_map(|item| {
            item.recurrence_id.as_ref().and_then(|recurrence_id| {
                time_value_key(recurrence_id)
                    .ok()
                    .map(|key| (item.calendar_id.clone(), item.uid.clone(), key))
            })
        })
        .collect::<HashSet<_>>();

    let mut expanded = Vec::new();
    for item in items {
        let remaining = MAX_CALENDAR_EXPANDED_CANDIDATES.saturating_sub(expanded.len());
        if remaining == 0 {
            break;
        }
        if item.recurrence_id.is_some() {
            if active_exception_ids.contains(item.id.as_str()) {
                let mut exception = item.clone();
                if exception.recurrence.is_none() {
                    exception.recurrence = exception
                        .recurrence_series_id
                        .as_deref()
                        .and_then(|id| masters.get(id))
                        .and_then(|master| master.recurrence.clone());
                }
                expanded.push(exception);
            }
            continue;
        }
        for occurrence in
            expand_recurring_item(item, query.from, query.to, query.limit.min(remaining))?
        {
            let is_overridden = occurrence
                .recurrence_id
                .as_ref()
                .is_some_and(|recurrence_id| {
                    time_value_key(recurrence_id).is_ok_and(|key| {
                        exception_keys.contains(&(
                            occurrence.calendar_id.clone(),
                            occurrence.uid.clone(),
                            key,
                        ))
                    })
                });
            if !is_overridden {
                expanded.push(occurrence);
            }
        }
    }

    let mut ranged = expanded
        .into_iter()
        .filter(|item| query.include_deleted || item.deleted_at.is_none())
        .map(|item| {
            let range = item_range_for_query(&item, query.from, query.to)?;
            Ok(RangedItem { item, range })
        })
        .collect::<Result<Vec<_>, CalendarQueryError>>()?;
    ranged.retain(|entry| match entry.range {
        Some((start, end)) => start < query.to && end > query.from,
        None => query.include_unscheduled_tasks && entry.item.kind == CalendarItemKind::Task,
    });
    ranged.sort_by(|left, right| {
        match (left.range, right.range) {
            (Some(left), Some(right)) => left.0.cmp(&right.0),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => std::cmp::Ordering::Equal,
        }
        .then_with(|| left.item.title.cmp(&right.item.title))
        .then_with(|| left.item.id.cmp(&right.item.id))
    });
    Ok(ranged
        .into_iter()
        .take(query.limit)
        .map(|entry| entry.item)
        .collect())
}

fn recurrence_base(item: &CalendarItem) -> Option<&CalendarTimeValue> {
    match item.kind {
        CalendarItemKind::Event => item.start.as_ref(),
        CalendarItemKind::Task => item.start.as_ref().or(item.due.as_ref()),
        CalendarItemKind::Birthday => None,
    }
}

fn expand_recurring_item(
    item: &CalendarItem,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    limit: usize,
) -> Result<Vec<CalendarItem>, CalendarQueryError> {
    let Some(recurrence) = item.recurrence.as_ref() else {
        return Ok(vec![item.clone()]);
    };
    let Some(base_value) = recurrence_base(item) else {
        return Ok(vec![item.clone()]);
    };
    if limit == 0 {
        return Ok(Vec::new());
    }

    let base = time_value_rrule(base_value)?;
    let rule_text = recurrence
        .rrule
        .strip_prefix("RRULE:")
        .unwrap_or(&recurrence.rrule);
    let rule = rule_text
        .parse::<RRule<Unvalidated>>()
        .map_err(|error| CalendarQueryError::InvalidRecurrence(error.to_string()))?;
    let duration = item_duration(item, base_value)?;
    let zone = base.timezone();
    let after = (from - duration - Duration::seconds(1)).with_timezone(&zone);
    let before = to.with_timezone(&zone);
    let mut set = rule
        .build(base)
        .map_err(|error| CalendarQueryError::InvalidRecurrence(error.to_string()))?
        .after(after)
        .before(before);
    for rdate in &recurrence.rdates {
        set = set.rdate(time_value_rrule_in_zone(rdate, &zone)?);
    }
    for exdate in &recurrence.exdates {
        set = set.exdate(time_value_rrule_in_zone(exdate, &zone)?);
    }

    let mut results = Vec::new();
    let occurrence_limit = u16::try_from(limit)
        .unwrap_or(u16::MAX)
        .min(MAX_RECURRENCE_RESULTS);
    for occurrence in set.all(occurrence_limit).dates {
        let instant = occurrence.with_timezone(&Utc);
        if instant >= to || instant + duration <= from {
            continue;
        }
        results.push(shifted_occurrence(item, base_value, instant)?);
    }
    Ok(results)
}

fn recurrence_includes(
    item: &CalendarItem,
    recurrence_id: &CalendarTimeValue,
) -> Result<bool, CalendarQueryError> {
    let target = time_value_instant(recurrence_id)?;
    Ok(expand_recurring_item(
        item,
        target,
        target + Duration::milliseconds(1),
        usize::from(MAX_RECURRENCE_RESULTS),
    )?
    .iter()
    .any(|occurrence| {
        occurrence
            .recurrence_id
            .as_ref()
            .and_then(|value| time_value_key(value).ok())
            == time_value_key(recurrence_id).ok()
    }))
}

fn shifted_occurrence(
    item: &CalendarItem,
    base: &CalendarTimeValue,
    occurrence: DateTime<Utc>,
) -> Result<CalendarItem, CalendarQueryError> {
    let delta = occurrence - time_value_instant(base)?;
    let recurrence_id = shift_time_value(base, delta)?;
    let occurrence_key = match &recurrence_id {
        CalendarTimeValue::Date { date } => date.clone(),
        CalendarTimeValue::DateTime { date_time, .. } => date_time.clone(),
    };
    let mut shifted = item.clone();
    shifted.id = format!("{}::{occurrence_key}", item.id);
    shifted.recurrence_id = Some(recurrence_id);
    shifted.recurrence_series_id = Some(item.id.clone());
    shifted.start = item
        .start
        .as_ref()
        .map(|value| shift_time_value(value, delta))
        .transpose()?;
    shifted.end = item
        .end
        .as_ref()
        .map(|value| shift_time_value(value, delta))
        .transpose()?;
    shifted.due = item
        .due
        .as_ref()
        .map(|value| shift_time_value(value, delta))
        .transpose()?;
    if item.kind == CalendarItemKind::Birthday {
        shifted.date = item
            .date
            .as_deref()
            .map(|date| shift_date(date, delta))
            .transpose()?;
    }
    Ok(shifted)
}

fn item_duration(
    item: &CalendarItem,
    base: &CalendarTimeValue,
) -> Result<Duration, CalendarQueryError> {
    match item.kind {
        CalendarItemKind::Event => match (&item.start, &item.end) {
            (Some(start), Some(end)) => Ok(time_value_instant(end)? - time_value_instant(start)?),
            _ => Ok(Duration::milliseconds(1)),
        },
        CalendarItemKind::Task => {
            let end = item.due.as_ref().or(item.start.as_ref()).unwrap_or(base);
            Ok((time_value_instant(end)? - time_value_instant(base)?)
                .max(Duration::milliseconds(1)))
        }
        CalendarItemKind::Birthday => Ok(Duration::days(1)),
    }
}

fn item_range_for_query(
    item: &CalendarItem,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
) -> Result<Option<(DateTime<Utc>, DateTime<Utc>)>, CalendarQueryError> {
    match item.kind {
        CalendarItemKind::Event => match (&item.start, &item.end) {
            (Some(start), Some(end)) => {
                Ok(Some((time_value_instant(start)?, time_value_instant(end)?)))
            }
            _ => Ok(None),
        },
        CalendarItemKind::Task => {
            let start = item.start.as_ref().or(item.due.as_ref());
            let end = item.due.as_ref().or(item.start.as_ref());
            match (start, end) {
                (Some(start), Some(end_value)) => {
                    let start = time_value_instant(start)?;
                    let mut end = time_value_instant(end_value)?;
                    if matches!(end_value, CalendarTimeValue::Date { .. }) {
                        end += Duration::days(1) - Duration::milliseconds(1);
                    }
                    if end <= start {
                        end = start + Duration::milliseconds(1);
                    }
                    Ok(Some((start, end)))
                }
                _ => Ok(None),
            }
        }
        CalendarItemKind::Birthday => {
            let Some(date) = item.date.as_deref() else {
                return Ok(None);
            };
            let parsed = parse_date(date)?;
            for year in from.year()..=to.year() {
                let Some(projected) = NaiveDate::from_ymd_opt(year, parsed.month(), parsed.day())
                else {
                    continue;
                };
                let start = projected.and_hms_opt(0, 0, 0).unwrap().and_utc();
                let end = start + Duration::days(1);
                if start < to && end > from {
                    return Ok(Some((start, end)));
                }
            }
            Ok(None)
        }
    }
}

fn time_value_rrule(value: &CalendarTimeValue) -> Result<DateTime<Tz>, CalendarQueryError> {
    match value {
        CalendarTimeValue::Date { date } => Ok(parse_date(date)?
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
            .with_timezone(&Tz::UTC)),
        CalendarTimeValue::DateTime {
            date_time,
            time_zone,
        } => {
            let zone = parse_time_zone(time_zone)?;
            Ok(parse_date_time(date_time)?.with_timezone(&zone))
        }
    }
}

fn time_value_rrule_in_zone(
    value: &CalendarTimeValue,
    zone: &Tz,
) -> Result<DateTime<Tz>, CalendarQueryError> {
    Ok(time_value_instant(value)?.with_timezone(zone))
}

fn time_value_instant(value: &CalendarTimeValue) -> Result<DateTime<Utc>, CalendarQueryError> {
    match value {
        CalendarTimeValue::Date { date } => {
            Ok(parse_date(date)?.and_hms_opt(0, 0, 0).unwrap().and_utc())
        }
        CalendarTimeValue::DateTime { date_time, .. } => parse_date_time(date_time),
    }
}

fn shift_time_value(
    value: &CalendarTimeValue,
    delta: Duration,
) -> Result<CalendarTimeValue, CalendarQueryError> {
    match value {
        CalendarTimeValue::Date { date } => Ok(CalendarTimeValue::Date {
            date: shift_date(date, delta)?,
        }),
        CalendarTimeValue::DateTime {
            date_time,
            time_zone,
        } => Ok(CalendarTimeValue::DateTime {
            date_time: (parse_date_time(date_time)? + delta)
                .to_rfc3339_opts(SecondsFormat::Millis, true),
            time_zone: time_zone.clone(),
        }),
    }
}

fn shift_date(date: &str, delta: Duration) -> Result<String, CalendarQueryError> {
    Ok((parse_date(date)? + delta).format("%Y-%m-%d").to_string())
}

fn time_value_key(value: &CalendarTimeValue) -> Result<String, CalendarQueryError> {
    match value {
        CalendarTimeValue::Date { date } => Ok(format!("date:{date}")),
        CalendarTimeValue::DateTime { date_time, .. } => Ok(format!(
            "dateTime:{}",
            parse_date_time(date_time)?.to_rfc3339_opts(SecondsFormat::Millis, true)
        )),
    }
}

fn parse_date(value: &str) -> Result<NaiveDate, CalendarQueryError> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| CalendarQueryError::InvalidDate(value.to_string()))
}

fn parse_date_time(value: &str) -> Result<DateTime<Utc>, CalendarQueryError> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| CalendarQueryError::InvalidDateTime(value.to_string()))
}

fn parse_time_zone(value: &str) -> Result<Tz, CalendarQueryError> {
    value
        .parse::<chrono_tz::Tz>()
        .map(Tz::from)
        .map_err(|_| CalendarQueryError::InvalidTimeZone(value.to_string()))
}

use chrono::Datelike;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CalendarRecurrence;

    fn event(id: &str, start: &str, end: &str) -> CalendarItem {
        CalendarItem {
            id: id.into(),
            uid: id.into(),
            calendar_id: "calendar-1".into(),
            kind: CalendarItemKind::Event,
            title: id.into(),
            description: None,
            url: None,
            reminders: vec![],
            attendees: vec![],
            attachments: vec![],
            recurrence: None,
            recurrence_id: None,
            recurrence_series_id: None,
            source_binding: None,
            icalendar_properties: vec![],
            start: Some(CalendarTimeValue::DateTime {
                date_time: start.into(),
                time_zone: "Europe/Berlin".into(),
            }),
            end: Some(CalendarTimeValue::DateTime {
                date_time: end.into(),
                time_zone: "Europe/Berlin".into(),
            }),
            due: None,
            date: None,
            birth_year: None,
            location: None,
            availability: None,
            priority: None,
            status: None,
            completed_at: None,
            revision: 1,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            deleted_at: None,
        }
    }

    fn query(from: &str, to: &str) -> CalendarQueryRange {
        CalendarQueryRange {
            from: parse_date_time(from).unwrap(),
            to: parse_date_time(to).unwrap(),
            limit: 100,
            include_deleted: false,
            include_unscheduled_tasks: false,
        }
    }

    #[test]
    fn expands_across_dst_using_the_calendar_wall_time() {
        let mut master = event("standup", "2026-03-27T08:00:00Z", "2026-03-27T09:00:00Z");
        master.recurrence = Some(CalendarRecurrence {
            rrule: "FREQ=DAILY;COUNT=5".into(),
            rdates: vec![],
            exdates: vec![],
        });
        let items = query_calendar_items(
            &[master],
            query("2026-03-27T00:00:00Z", "2026-04-02T00:00:00Z"),
        )
        .unwrap();
        let starts = items
            .iter()
            .map(|item| match item.start.as_ref().unwrap() {
                CalendarTimeValue::DateTime { date_time, .. } => date_time.as_str(),
                CalendarTimeValue::Date { .. } => unreachable!(),
            })
            .collect::<Vec<_>>();
        assert_eq!(
            starts,
            vec![
                "2026-03-27T08:00:00.000Z",
                "2026-03-28T08:00:00.000Z",
                "2026-03-29T07:00:00.000Z",
                "2026-03-30T07:00:00.000Z",
                "2026-03-31T07:00:00.000Z",
            ]
        );
    }

    #[test]
    fn exception_replaces_generated_occurrence() {
        let mut master = event("standup", "2026-08-01T08:00:00Z", "2026-08-01T09:00:00Z");
        master.recurrence = Some(CalendarRecurrence {
            rrule: "FREQ=DAILY;COUNT=3".into(),
            rdates: vec![],
            exdates: vec![],
        });
        let mut exception = event(
            "standup-exception",
            "2026-08-02T10:00:00Z",
            "2026-08-02T11:00:00Z",
        );
        exception.uid = master.uid.clone();
        exception.title = "Moved standup".into();
        exception.recurrence_id = Some(CalendarTimeValue::DateTime {
            date_time: "2026-08-02T08:00:00Z".into(),
            time_zone: "Europe/Berlin".into(),
        });
        exception.recurrence_series_id = Some(master.id.clone());

        let items = query_calendar_items(
            &[master, exception],
            query("2026-08-01T00:00:00Z", "2026-08-04T00:00:00Z"),
        )
        .unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[1].title, "Moved standup");
    }
}
