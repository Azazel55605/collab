use crate::{
    CalendarAttachment, CalendarAttendee, CalendarDefinition, CalendarEventLocation, CalendarItem,
    CalendarItemKind, CalendarRecurrence, CalendarReminder, CalendarSourceBinding,
    CalendarTimeValue,
};
use chrono::{DateTime, Duration, LocalResult, NaiveDate, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use uuid::Uuid;

pub const MAX_ICS_BYTES: usize = 5 * 1024 * 1024;
pub const MAX_ICS_ITEMS: usize = 5_000;
pub const MAX_ICS_LINE_LENGTH: usize = 64 * 1024;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum IcsParseError {
    #[error("iCalendar data exceeds the 5 MB limit")]
    TooLarge,
    #[error("an iCalendar content line exceeds the supported limit")]
    LineTooLong,
    #[error("iCalendar data does not contain a VCALENDAR")]
    InvalidCalendar,
    #[error("iCalendar data contains more than 5000 items")]
    TooManyItems,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedIcsCalendar {
    pub name: Option<String>,
    pub items: Vec<CalendarItem>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
struct ContentLine {
    name: String,
    parameters: HashMap<String, String>,
    value: String,
    raw: String,
}

fn unfold(content: &str) -> Result<Vec<String>, IcsParseError> {
    if content.len() > MAX_ICS_BYTES {
        return Err(IcsParseError::TooLarge);
    }
    let mut lines: Vec<String> = Vec::new();
    for physical in content
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .split('\n')
    {
        if physical.len() > MAX_ICS_LINE_LENGTH {
            return Err(IcsParseError::LineTooLong);
        }
        if physical.starts_with([' ', '\t']) {
            if let Some(previous) = lines.last_mut() {
                previous.push_str(&physical[1..]);
                if previous.len() > MAX_ICS_LINE_LENGTH {
                    return Err(IcsParseError::LineTooLong);
                }
            }
        } else {
            lines.push(physical.to_owned());
        }
    }
    Ok(lines)
}

fn split_quoted(value: &str, separator: char) -> Vec<&str> {
    let mut values = Vec::new();
    let mut quoted = false;
    let mut escaped = false;
    let mut start = 0;
    for (index, character) in value.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
        } else if character == '"' {
            quoted = !quoted;
        } else if character == separator && !quoted {
            values.push(&value[start..index]);
            start = index + character.len_utf8();
        }
    }
    values.push(&value[start..]);
    values
}

fn content_line(raw: &str) -> Option<ContentLine> {
    let mut quoted = false;
    let mut escaped = false;
    let mut colon = None;
    for (index, character) in raw.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
        } else if character == '"' {
            quoted = !quoted;
        } else if character == ':' && !quoted {
            colon = Some(index);
            break;
        }
    }
    let colon = colon?;
    let head = &raw[..colon];
    let mut segments = split_quoted(head, ';').into_iter();
    let name = segments.next()?.trim().to_ascii_uppercase();
    if name.is_empty() {
        return None;
    }
    let mut parameters = HashMap::new();
    for segment in segments {
        let Some((key, value)) = segment.split_once('=') else {
            continue;
        };
        parameters.insert(
            key.trim().to_ascii_uppercase(),
            value.trim().trim_matches('"').replace("\\\"", "\""),
        );
    }
    Some(ContentLine {
        name,
        parameters,
        value: raw[colon + 1..].to_owned(),
        raw: raw.to_owned(),
    })
}

fn unescape_text(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut escaped = false;
    for character in value.chars() {
        if escaped {
            output.push(match character {
                'n' | 'N' => '\n',
                other => other,
            });
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else {
            output.push(character);
        }
    }
    if escaped {
        output.push('\\');
    }
    output
}

fn first<'a>(lines: &'a [ContentLine], name: &str) -> Option<&'a ContentLine> {
    lines.iter().find(|line| line.name == name)
}

fn stable_id(namespace: &str, key: &str) -> String {
    let digest = Sha256::digest(format!("{namespace}\0{key}").as_bytes());
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes).to_string()
}

fn parse_date(value: &str) -> Option<String> {
    NaiveDate::parse_from_str(value, "%Y%m%d")
        .ok()
        .map(|value| value.format("%Y-%m-%d").to_string())
}

fn parse_local_datetime(value: &str) -> Option<NaiveDateTime> {
    NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%S")
        .or_else(|_| NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M"))
        .ok()
}

fn local_to_utc(naive: NaiveDateTime, time_zone: &str) -> Option<DateTime<Utc>> {
    let zone = time_zone.parse::<Tz>().ok()?;
    match zone.from_local_datetime(&naive) {
        LocalResult::Single(value) => Some(value.with_timezone(&Utc)),
        LocalResult::Ambiguous(first, _) => Some(first.with_timezone(&Utc)),
        LocalResult::None => None,
    }
}

fn parse_time(
    line: &ContentLine,
    fallback_time_zone: &str,
    preserved_time_zone: Option<&str>,
) -> Option<CalendarTimeValue> {
    if line
        .parameters
        .get("VALUE")
        .is_some_and(|value| value == "DATE")
        || (!line.value.contains('T') && line.value.len() == 8)
    {
        return Some(CalendarTimeValue::Date {
            date: parse_date(&line.value)?,
        });
    }
    let parameter_time_zone = line.parameters.get("TZID").map(String::as_str);
    let display_time_zone = preserved_time_zone
        .or(parameter_time_zone)
        .unwrap_or(fallback_time_zone);
    let utc = if line.value.ends_with('Z') {
        NaiveDateTime::parse_from_str(&line.value, "%Y%m%dT%H%M%SZ")
            .or_else(|_| NaiveDateTime::parse_from_str(&line.value, "%Y%m%dT%H%MZ"))
            .ok()
            .map(|value| value.and_utc())
    } else if line.value.len() >= 5
        && matches!(
            line.value.as_bytes().get(line.value.len() - 5),
            Some(b'+' | b'-')
        )
    {
        DateTime::parse_from_str(&line.value, "%Y%m%dT%H%M%S%z")
            .or_else(|_| DateTime::parse_from_str(&line.value, "%Y%m%dT%H%M%z"))
            .ok()
            .map(|value| value.with_timezone(&Utc))
    } else {
        parse_local_datetime(&line.value).and_then(|value| {
            local_to_utc(value, parameter_time_zone.unwrap_or(fallback_time_zone))
        })
    }?;
    Some(CalendarTimeValue::DateTime {
        date_time: utc.to_rfc3339(),
        time_zone: display_time_zone.to_owned(),
    })
}

fn time_value(
    lines: &[ContentLine],
    name: &str,
    fallback_time_zone: &str,
) -> Option<CalendarTimeValue> {
    let preserved =
        first(lines, &format!("X-COLLAB-{name}-TIMEZONE")).map(|line| line.value.as_str());
    parse_time(first(lines, name)?, fallback_time_zone, preserved)
}

fn recurrence_values(
    lines: &[ContentLine],
    name: &str,
    fallback_time_zone: &str,
) -> Vec<CalendarTimeValue> {
    lines
        .iter()
        .filter(|line| line.name == name)
        .flat_map(|line| {
            split_quoted(&line.value, ',')
                .into_iter()
                .filter_map(|value| {
                    let mut line = line.clone();
                    line.value = value.to_owned();
                    parse_time(&line, fallback_time_zone, None)
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

fn time_key(value: &CalendarTimeValue) -> String {
    match value {
        CalendarTimeValue::Date { date } => format!("date:{date}"),
        CalendarTimeValue::DateTime { date_time, .. } => format!("instant:{date_time}"),
    }
}

fn add_default_duration(value: &CalendarTimeValue) -> CalendarTimeValue {
    match value {
        CalendarTimeValue::Date { date } => CalendarTimeValue::Date {
            date: NaiveDate::parse_from_str(date, "%Y-%m-%d")
                .ok()
                .and_then(|value| value.succ_opt())
                .unwrap_or_else(|| NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap())
                .format("%Y-%m-%d")
                .to_string(),
        },
        CalendarTimeValue::DateTime {
            date_time,
            time_zone,
        } => CalendarTimeValue::DateTime {
            date_time: DateTime::parse_from_rfc3339(date_time)
                .map(|value| (value.with_timezone(&Utc) + Duration::hours(1)).to_rfc3339())
                .unwrap_or_else(|_| date_time.clone()),
            time_zone: time_zone.clone(),
        },
    }
}

fn parse_duration(value: &str) -> Option<i64> {
    let mut input = value;
    let negative = input.starts_with('-');
    if negative || input.starts_with('+') {
        input = &input[1..];
    }
    if !input.starts_with('P') {
        return None;
    }
    input = &input[1..];
    let mut seconds = 0_i64;
    let mut number = String::new();
    let mut time = false;
    for character in input.chars() {
        if character.is_ascii_digit() {
            number.push(character);
            continue;
        }
        if character == 'T' {
            time = true;
            continue;
        }
        let value = number.parse::<i64>().ok()?;
        number.clear();
        seconds += match character {
            'W' => value * 7 * 86_400,
            'D' => value * 86_400,
            'H' if time => value * 3_600,
            'M' if time => value * 60,
            'S' if time => value,
            _ => return None,
        };
    }
    Some(if negative { -seconds } else { seconds })
}

fn reminders(alarms: &[Vec<ContentLine>], fallback_time_zone: &str) -> Vec<CalendarReminder> {
    alarms
        .iter()
        .filter_map(|alarm| {
            let trigger = first(alarm, "TRIGGER")?;
            if let Some(seconds) = parse_duration(&trigger.value) {
                return (seconds <= 0).then_some(CalendarReminder::Relative {
                    minutes_before: (-seconds / 60).max(0),
                });
            }
            match parse_time(trigger, fallback_time_zone, None)? {
                CalendarTimeValue::DateTime { date_time, .. } => {
                    Some(CalendarReminder::Absolute { at: date_time })
                }
                CalendarTimeValue::Date { .. } => None,
            }
        })
        .collect()
}

fn attendees(lines: &[ContentLine]) -> Vec<CalendarAttendee> {
    lines
        .iter()
        .filter(|line| line.name == "ATTENDEE")
        .filter_map(|line| {
            let email = line
                .value
                .strip_prefix("mailto:")
                .or_else(|| line.value.strip_prefix("MAILTO:"))?;
            (!email.trim().is_empty()).then(|| CalendarAttendee::Email {
                id: stable_id("ics-attendee", email),
                email: email.trim().to_ascii_lowercase(),
                display_name: line.parameters.get("CN").map(|value| unescape_text(value)),
                response: match line.parameters.get("PARTSTAT").map(|value| value.as_str()) {
                    Some("ACCEPTED") => "accepted",
                    Some("DECLINED") => "declined",
                    Some("TENTATIVE") => "tentative",
                    _ => "needs-action",
                }
                .into(),
                role: if line
                    .parameters
                    .get("ROLE")
                    .is_some_and(|value| value == "OPT-PARTICIPANT")
                {
                    "optional"
                } else {
                    "required"
                }
                .into(),
            })
        })
        .take(100)
        .collect()
}

fn attachments(lines: &[ContentLine]) -> Vec<CalendarAttachment> {
    lines
        .iter()
        .filter(|line| line.name == "ATTACH")
        .filter(|line| line.value.starts_with("https://") || line.value.starts_with("http://"))
        .map(|line| CalendarAttachment::ExternalUrl {
            id: stable_id("ics-attachment", &line.value),
            name: line
                .parameters
                .get("FILENAME")
                .map(|value| unescape_text(value))
                .unwrap_or_else(|| line.value.clone()),
            url: line.value.clone(),
        })
        .take(50)
        .collect()
}

fn parse_item(
    component: &str,
    lines: &[ContentLine],
    alarms: &[Vec<ContentLine>],
    calendar: &CalendarDefinition,
    subscription_id: &str,
    now: &str,
) -> Result<CalendarItem, String> {
    let uid = first(lines, "UID")
        .map(|line| unescape_text(&line.value))
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "A calendar item is missing its UID.".to_string())?;
    let title = first(lines, "SUMMARY")
        .map(|line| unescape_text(&line.value))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Untitled".into());
    let recurrence_id = time_value(lines, "RECURRENCE-ID", &calendar.default_time_zone);
    let key = format!(
        "{}\0{}",
        uid,
        recurrence_id
            .as_ref()
            .map(time_key)
            .unwrap_or_else(|| "master".into())
    );
    let rrule = first(lines, "RRULE").map(|line| line.value.clone());
    let rdates = recurrence_values(lines, "RDATE", &calendar.default_time_zone);
    let exdates = recurrence_values(lines, "EXDATE", &calendar.default_time_zone);
    let recurrence = rrule.map(|rrule| CalendarRecurrence {
        rrule,
        rdates,
        exdates,
    });
    let timestamp = |name: &str| {
        first(lines, name)
            .and_then(|line| parse_time(line, "UTC", None))
            .and_then(|value| match value {
                CalendarTimeValue::DateTime { date_time, .. } => Some(date_time),
                CalendarTimeValue::Date { .. } => None,
            })
    };
    let icalendar_properties = lines
        .iter()
        .filter(|line| {
            line.name.starts_with("X-")
                && !line.name.starts_with("X-COLLAB-")
                && line.raw.len() <= crate::MAX_ICALENDAR_PROPERTY_LENGTH
        })
        .map(|line| line.raw.clone())
        .take(crate::MAX_ICALENDAR_PROPERTIES)
        .collect();
    let mut item = CalendarItem {
        id: stable_id(subscription_id, &key),
        uid: uid.clone(),
        calendar_id: calendar.id.clone(),
        kind: CalendarItemKind::Event,
        title,
        description: first(lines, "DESCRIPTION").map(|line| unescape_text(&line.value)),
        url: first(lines, "URL").map(|line| line.value.clone()),
        reminders: reminders(alarms, &calendar.default_time_zone),
        attendees: attendees(lines),
        attachments: attachments(lines),
        recurrence,
        recurrence_id,
        recurrence_series_id: None,
        source_binding: Some(CalendarSourceBinding::External {
            subscription_id: subscription_id.into(),
            external_uid: uid,
        }),
        icalendar_properties,
        start: None,
        end: None,
        due: None,
        date: None,
        birth_year: None,
        location: None,
        availability: None,
        priority: None,
        status: None,
        completed_at: None,
        revision: 0,
        created_at: timestamp("CREATED").unwrap_or_else(|| now.into()),
        updated_at: timestamp("LAST-MODIFIED")
            .or_else(|| timestamp("DTSTAMP"))
            .unwrap_or_else(|| now.into()),
        deleted_at: None,
    };
    if component == "VTODO" {
        item.kind = CalendarItemKind::Task;
        item.start = time_value(lines, "DTSTART", &calendar.default_time_zone);
        item.due = time_value(lines, "DUE", &calendar.default_time_zone);
        item.status = Some(
            match first(lines, "STATUS").map(|line| line.value.as_str()) {
                Some("IN-PROCESS") => "in-progress",
                Some("COMPLETED") => "completed",
                Some("CANCELLED") => "cancelled",
                _ => "needs-action",
            }
            .into(),
        );
        item.priority = first(lines, "PRIORITY")
            .and_then(|line| line.value.parse::<i32>().ok())
            .filter(|value| *value != 0)
            .map(|value| {
                if value <= 4 {
                    "high"
                } else if value == 5 {
                    "medium"
                } else {
                    "low"
                }
                .into()
            });
        item.completed_at = timestamp("COMPLETED");
        return Ok(item);
    }
    let start = time_value(lines, "DTSTART", &calendar.default_time_zone)
        .ok_or_else(|| format!("Event \"{}\" is missing DTSTART.", item.title))?;
    if first(lines, "X-COLLAB-KIND").is_some_and(|line| line.value == "BIRTHDAY") {
        let CalendarTimeValue::Date { date } = start else {
            return Err(format!("Birthday \"{}\" must use a date.", item.title));
        };
        item.kind = CalendarItemKind::Birthday;
        item.date = Some(date);
        item.birth_year =
            first(lines, "X-COLLAB-BIRTH-YEAR").and_then(|line| line.value.parse::<i32>().ok());
        return Ok(item);
    }
    item.start = Some(start.clone());
    item.end = Some(
        time_value(lines, "DTEND", &calendar.default_time_zone)
            .unwrap_or_else(|| add_default_duration(&start)),
    );
    item.location = first(lines, "LOCATION").map(|line| CalendarEventLocation::Structured {
        label: unescape_text(&line.value),
        address: None,
        latitude: None,
        longitude: None,
        provider: None,
        provider_place_id: None,
    });
    item.availability = Some(
        if first(lines, "TRANSP").is_some_and(|line| line.value == "TRANSPARENT") {
            "free"
        } else {
            "busy"
        }
        .into(),
    );
    Ok(item)
}

pub fn parse_ics(
    content: &str,
    calendar: &CalendarDefinition,
    subscription_id: &str,
    now: &str,
) -> Result<ParsedIcsCalendar, IcsParseError> {
    let lines = unfold(content)?;
    if !lines
        .iter()
        .any(|line| line.eq_ignore_ascii_case("BEGIN:VCALENDAR"))
    {
        return Err(IcsParseError::InvalidCalendar);
    }
    let name = lines
        .iter()
        .filter_map(|line| content_line(line))
        .find_map(|line| (line.name == "X-WR-CALNAME").then(|| unescape_text(&line.value)));
    let mut components: Vec<(String, Vec<ContentLine>, Vec<Vec<ContentLine>>)> = Vec::new();
    let mut current: Option<(String, Vec<ContentLine>, Vec<Vec<ContentLine>>)> = None;
    let mut alarm: Option<Vec<ContentLine>> = None;
    for raw in &lines {
        let upper = raw.to_ascii_uppercase();
        if matches!(upper.as_str(), "BEGIN:VEVENT" | "BEGIN:VTODO") {
            current = Some((
                upper.trim_start_matches("BEGIN:").into(),
                Vec::new(),
                Vec::new(),
            ));
            continue;
        }
        if upper == "BEGIN:VALARM" && current.is_some() {
            alarm = Some(Vec::new());
            continue;
        }
        if upper == "END:VALARM" {
            if let (Some(value), Some((_, _, alarms))) = (alarm.take(), current.as_mut()) {
                alarms.push(value);
            }
            continue;
        }
        if matches!(upper.as_str(), "END:VEVENT" | "END:VTODO") {
            if let Some(value) = current.take() {
                components.push(value);
                if components.len() > MAX_ICS_ITEMS {
                    return Err(IcsParseError::TooManyItems);
                }
            }
            continue;
        }
        let Some(line) = content_line(raw) else {
            continue;
        };
        if let Some(alarm) = alarm.as_mut() {
            alarm.push(line);
        } else if let Some((_, lines, _)) = current.as_mut() {
            lines.push(line);
        }
    }
    let mut items = Vec::new();
    let mut warnings = Vec::new();
    for (component, lines, alarms) in components {
        match parse_item(&component, &lines, &alarms, calendar, subscription_id, now) {
            Ok(item) => items.push(item),
            Err(error) => warnings.push(error),
        }
    }
    let master_ids = items
        .iter()
        .filter(|item| item.recurrence_id.is_none())
        .map(|item| (item.uid.clone(), item.id.clone()))
        .collect::<HashMap<_, _>>();
    for item in &mut items {
        if item.recurrence_id.is_some() {
            item.recurrence_series_id = master_ids.get(&item.uid).cloned();
        }
    }
    Ok(ParsedIcsCalendar {
        name,
        items,
        warnings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CalendarLocation;

    fn calendar() -> CalendarDefinition {
        CalendarDefinition {
            schema_version: 1,
            id: Uuid::now_v7().to_string(),
            global_id: Uuid::now_v7().to_string(),
            location: CalendarLocation::Subscription {
                subscription_id: Uuid::now_v7().to_string(),
                server_url: None,
                user_id: None,
            },
            name: "Feed".into(),
            color: "#60a5fa".into(),
            default_time_zone: "Europe/Berlin".into(),
            archived: false,
            read_only: true,
            revision: 1,
            created_at: "2026-07-26T10:00:00Z".into(),
            updated_at: "2026-07-26T10:00:00Z".into(),
            deleted_at: None,
        }
    }

    #[test]
    fn parses_time_zones_recurrence_alarms_and_safe_extensions() {
        let content = concat!(
            "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nX-WR-CALNAME:Work\r\n",
            "BEGIN:VEVENT\r\nUID:event-1\r\nSUMMARY:Berlin meeting\r\n",
            "DTSTART;TZID=Europe/Berlin:20261025T023000\r\n",
            "DTEND;TZID=Europe/Berlin:20261025T033000\r\n",
            "RRULE:FREQ=WEEKLY;COUNT=2\r\nX-MICROSOFT-CDO-BUSYSTATUS:BUSY\r\n",
            "BEGIN:VALARM\r\nTRIGGER:-PT15M\r\nEND:VALARM\r\n",
            "END:VEVENT\r\nEND:VCALENDAR\r\n"
        );
        let parsed = parse_ics(
            content,
            &calendar(),
            "subscription-1",
            "2026-07-26T10:00:00Z",
        )
        .unwrap();
        assert_eq!(parsed.name.as_deref(), Some("Work"));
        assert_eq!(parsed.items.len(), 1);
        assert_eq!(
            parsed.items[0].start,
            Some(CalendarTimeValue::DateTime {
                date_time: "2026-10-25T00:30:00+00:00".into(),
                time_zone: "Europe/Berlin".into(),
            })
        );
        assert_eq!(
            parsed.items[0].reminders,
            vec![CalendarReminder::Relative { minutes_before: 15 }]
        );
        assert_eq!(
            parsed.items[0].icalendar_properties,
            vec!["X-MICROSOFT-CDO-BUSYSTATUS:BUSY"]
        );
    }

    #[test]
    fn rejects_oversized_item_sets() {
        let mut content = "BEGIN:VCALENDAR\r\n".to_owned();
        for index in 0..=MAX_ICS_ITEMS {
            content.push_str(&format!(
                "BEGIN:VEVENT\r\nUID:{index}\r\nSUMMARY:{index}\r\nDTSTART;VALUE=DATE:20260727\r\nEND:VEVENT\r\n"
            ));
        }
        content.push_str("END:VCALENDAR\r\n");
        assert_eq!(
            parse_ics(
                &content,
                &calendar(),
                "subscription-1",
                "2026-07-26T10:00:00Z"
            ),
            Err(IcsParseError::TooManyItems)
        );
    }

    #[test]
    fn rejects_oversized_content_lines_and_ignores_reserved_extensions() {
        let oversized = format!(
            "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nSUMMARY:{}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
            "x".repeat(MAX_ICS_LINE_LENGTH + 1)
        );
        assert_eq!(
            parse_ics(
                &oversized,
                &calendar(),
                "subscription-1",
                "2026-07-26T10:00:00Z"
            ),
            Err(IcsParseError::LineTooLong)
        );
        let content = concat!(
            "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:1\r\nSUMMARY:Safe\r\n",
            "DTSTART;VALUE=DATE:20260727\r\n",
            "X-COLLAB-START-TIMEZONE:Injected/Zone\r\n",
            "X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:DISABLED\r\n",
            "END:VEVENT\r\nEND:VCALENDAR\r\n"
        );
        let parsed = parse_ics(
            content,
            &calendar(),
            "subscription-1",
            "2026-07-26T10:00:00Z",
        )
        .unwrap();
        assert_eq!(
            parsed.items[0].icalendar_properties,
            vec!["X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:DISABLED"]
        );
    }
}
