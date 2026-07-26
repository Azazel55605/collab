use crate::{
    CalendarAttachment, CalendarAttendee, CalendarDefinition, CalendarEventLocation, CalendarItem,
    CalendarItemKind, CalendarReminder, CalendarTimeValue,
};
use chrono::{DateTime, Utc};

const PROD_ID: &str = "-//Collab//Calendar//EN";

fn escape_text(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace(';', "\\;")
        .replace(',', "\\,")
        .replace("\r\n", "\\n")
        .replace(['\r', '\n'], "\\n")
}

fn escape_parameter(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn format_timestamp(value: &str) -> Option<String> {
    DateTime::parse_from_rfc3339(value).ok().map(|value| {
        value
            .with_timezone(&Utc)
            .format("%Y%m%dT%H%M%SZ")
            .to_string()
    })
}

fn format_date(value: &str) -> Option<String> {
    let compact = value.replace('-', "");
    (compact.len() == 8 && compact.chars().all(|character| character.is_ascii_digit()))
        .then_some(compact)
}

fn time_property(name: &str, value: &CalendarTimeValue) -> Option<String> {
    match value {
        CalendarTimeValue::Date { date } => {
            Some(format!("{name};VALUE=DATE:{}", format_date(date)?))
        }
        CalendarTimeValue::DateTime { date_time, .. } => {
            Some(format!("{name}:{}", format_timestamp(date_time)?))
        }
    }
}

fn push_folded(lines: &mut Vec<String>, line: String) {
    const LIMIT: usize = 75;
    if line.len() <= LIMIT {
        lines.push(line);
        return;
    }
    let mut remaining = line.as_str();
    let mut first = true;
    while !remaining.is_empty() {
        let prefix = if first { "" } else { " " };
        let available = LIMIT - prefix.len();
        let mut end = remaining.len().min(available);
        while !remaining.is_char_boundary(end) {
            end -= 1;
        }
        lines.push(format!("{prefix}{}", &remaining[..end]));
        remaining = &remaining[end..];
        first = false;
    }
}

fn push_time(lines: &mut Vec<String>, name: &str, value: Option<&CalendarTimeValue>) {
    if let Some(line) = value.and_then(|value| time_property(name, value)) {
        push_folded(lines, line);
    }
}

fn item_lines(item: &CalendarItem) -> Vec<String> {
    let component = if item.kind == CalendarItemKind::Task {
        "VTODO"
    } else {
        "VEVENT"
    };
    let mut lines = vec![format!("BEGIN:{component}")];
    push_folded(&mut lines, format!("UID:{}", escape_text(&item.uid)));
    if let Some(value) = format_timestamp(&item.created_at) {
        lines.push(format!("DTSTAMP:{value}"));
    }
    if let Some(value) = format_timestamp(&item.updated_at) {
        lines.push(format!("LAST-MODIFIED:{value}"));
    }
    push_folded(&mut lines, format!("SUMMARY:{}", escape_text(&item.title)));
    if let Some(value) = item
        .description
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        push_folded(&mut lines, format!("DESCRIPTION:{}", escape_text(value)));
    }
    if let Some(value) = item.url.as_deref().filter(|value| !value.is_empty()) {
        push_folded(&mut lines, format!("URL:{value}"));
    }
    push_time(&mut lines, "RECURRENCE-ID", item.recurrence_id.as_ref());
    if let Some(recurrence) = &item.recurrence {
        push_folded(&mut lines, format!("RRULE:{}", recurrence.rrule));
        for value in &recurrence.rdates {
            push_time(&mut lines, "RDATE", Some(value));
        }
        for value in &recurrence.exdates {
            push_time(&mut lines, "EXDATE", Some(value));
        }
    }

    match item.kind {
        CalendarItemKind::Event => {
            push_time(&mut lines, "DTSTART", item.start.as_ref());
            push_time(&mut lines, "DTEND", item.end.as_ref());
            if let Some(location) = &item.location {
                let label = match location {
                    CalendarEventLocation::Legacy(value) => value,
                    CalendarEventLocation::Structured { label, .. } => label,
                };
                push_folded(&mut lines, format!("LOCATION:{}", escape_text(label)));
            }
            lines.push(format!(
                "TRANSP:{}",
                if item.availability.as_deref() == Some("free") {
                    "TRANSPARENT"
                } else {
                    "OPAQUE"
                }
            ));
        }
        CalendarItemKind::Task => {
            push_time(&mut lines, "DTSTART", item.start.as_ref());
            push_time(&mut lines, "DUE", item.due.as_ref());
            let status = match item.status.as_deref() {
                Some("in-progress") => "IN-PROCESS",
                Some("completed") => "COMPLETED",
                Some("cancelled") => "CANCELLED",
                _ => "NEEDS-ACTION",
            };
            lines.push(format!("STATUS:{status}"));
            if let Some(value) = item.completed_at.as_deref().and_then(format_timestamp) {
                lines.push(format!("COMPLETED:{value}"));
            }
            if let Some(priority) = item.priority.as_deref() {
                lines.push(format!(
                    "PRIORITY:{}",
                    match priority {
                        "high" => 1,
                        "medium" => 5,
                        _ => 9,
                    }
                ));
            }
        }
        CalendarItemKind::Birthday => {
            if let Some(value) = item.date.as_deref().and_then(format_date) {
                lines.push(format!("DTSTART;VALUE=DATE:{value}"));
            }
            lines.push("X-COLLAB-KIND:BIRTHDAY".into());
            if let Some(year) = item.birth_year {
                lines.push(format!("X-COLLAB-BIRTH-YEAR:{year}"));
            }
        }
    }

    for reminder in &item.reminders {
        lines.push("BEGIN:VALARM".into());
        lines.push("ACTION:DISPLAY".into());
        push_folded(
            &mut lines,
            format!("DESCRIPTION:{}", escape_text(&item.title)),
        );
        match reminder {
            CalendarReminder::Relative { minutes_before } => {
                lines.push(format!("TRIGGER:-PT{}M", minutes_before.max(&0)));
            }
            CalendarReminder::Absolute { at } => {
                if let Some(value) = format_timestamp(at) {
                    lines.push(format!("TRIGGER;VALUE=DATE-TIME:{value}"));
                }
            }
        }
        lines.push("END:VALARM".into());
    }
    for attendee in &item.attendees {
        let CalendarAttendee::Email {
            email,
            display_name,
            response,
            role,
            ..
        } = attendee
        else {
            continue;
        };
        let mut parameters = String::new();
        if let Some(name) = display_name.as_deref().filter(|value| !value.is_empty()) {
            parameters.push_str(&format!(";CN=\"{}\"", escape_parameter(name)));
        }
        parameters.push_str(&format!(";PARTSTAT={}", response.to_ascii_uppercase()));
        parameters.push_str(if role == "optional" {
            ";ROLE=OPT-PARTICIPANT"
        } else {
            ";ROLE=REQ-PARTICIPANT"
        });
        push_folded(&mut lines, format!("ATTENDEE{parameters}:mailto:{email}"));
    }
    for attachment in &item.attachments {
        let CalendarAttachment::ExternalUrl { name, url, .. } = attachment else {
            continue;
        };
        push_folded(
            &mut lines,
            format!("ATTACH;FILENAME=\"{}\":{url}", escape_parameter(name)),
        );
    }
    for property in &item.icalendar_properties {
        if property.len() <= crate::MAX_ICALENDAR_PROPERTY_LENGTH
            && !property.contains(['\r', '\n'])
            && property.split_once(':').is_some_and(|(head, _)| {
                let head = head.to_ascii_uppercase();
                head.starts_with("X-") && !head.starts_with("X-COLLAB-")
            })
        {
            push_folded(&mut lines, property.clone());
        }
    }
    lines.push(format!("END:{component}"));
    lines
}

pub fn export_ics(calendar: &CalendarDefinition, items: &[CalendarItem]) -> String {
    let mut lines = vec![
        "BEGIN:VCALENDAR".into(),
        "VERSION:2.0".into(),
        format!("PRODID:{PROD_ID}"),
        "CALSCALE:GREGORIAN".into(),
    ];
    push_folded(
        &mut lines,
        format!("X-WR-CALNAME:{}", escape_text(&calendar.name)),
    );
    let mut included = items
        .iter()
        .filter(|item| item.calendar_id == calendar.id && item.deleted_at.is_none())
        .collect::<Vec<_>>();
    included.sort_by(|left, right| {
        left.uid
            .cmp(&right.uid)
            .then_with(|| left.id.cmp(&right.id))
    });
    for item in included {
        lines.extend(item_lines(item));
    }
    lines.push("END:VCALENDAR".into());
    format!("{}\r\n", lines.join("\r\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CalendarLocation, CalendarRecurrence};

    #[test]
    fn exports_bounded_calendar_values_as_crlf_icalendar() {
        let calendar = CalendarDefinition {
            schema_version: 1,
            id: "calendar-1".into(),
            global_id: "global-1".into(),
            location: CalendarLocation::Local {
                profile_id: "profile-1".into(),
            },
            name: "Work, shared".into(),
            color: "#7c3aed".into(),
            default_time_zone: "UTC".into(),
            archived: false,
            read_only: false,
            revision: 1,
            created_at: "2026-07-26T08:00:00Z".into(),
            updated_at: "2026-07-26T08:00:00Z".into(),
            deleted_at: None,
        };
        let item = CalendarItem {
            id: "item-1".into(),
            uid: "event-1@example.test".into(),
            calendar_id: calendar.id.clone(),
            kind: CalendarItemKind::Event,
            title: "Review, deploy".into(),
            description: Some("Line one\nLine two".into()),
            url: None,
            reminders: vec![CalendarReminder::Relative { minutes_before: 15 }],
            attendees: Vec::new(),
            attachments: Vec::new(),
            recurrence: Some(CalendarRecurrence {
                rrule: "FREQ=WEEKLY".into(),
                rdates: Vec::new(),
                exdates: Vec::new(),
            }),
            recurrence_id: None,
            recurrence_series_id: None,
            source_binding: None,
            icalendar_properties: vec![
                "X-MICROSOFT-CDO-BUSYSTATUS:BUSY".into(),
                "X-COLLAB-START-TIMEZONE:Injected/Zone".into(),
                "X-BROKEN:value\r\nATTENDEE:mailto:attacker@example.test".into(),
            ],
            start: Some(CalendarTimeValue::DateTime {
                date_time: "2026-07-26T09:00:00+02:00".into(),
                time_zone: "Europe/Berlin".into(),
            }),
            end: Some(CalendarTimeValue::DateTime {
                date_time: "2026-07-26T10:00:00+02:00".into(),
                time_zone: "Europe/Berlin".into(),
            }),
            due: None,
            date: None,
            birth_year: None,
            location: None,
            availability: Some("busy".into()),
            priority: None,
            status: None,
            completed_at: None,
            revision: 1,
            created_at: "2026-07-26T07:00:00Z".into(),
            updated_at: "2026-07-26T07:30:00Z".into(),
            deleted_at: None,
        };

        let value = export_ics(&calendar, &[item]);
        assert!(value.starts_with("BEGIN:VCALENDAR\r\n"));
        assert!(value.contains("X-WR-CALNAME:Work\\, shared\r\n"));
        assert!(value.contains("SUMMARY:Review\\, deploy\r\n"));
        assert!(value.contains("DESCRIPTION:Line one\\nLine two\r\n"));
        assert!(value.contains("DTSTART:20260726T070000Z\r\n"));
        assert!(value.contains("RRULE:FREQ=WEEKLY\r\n"));
        assert!(value.contains("X-MICROSOFT-CDO-BUSYSTATUS:BUSY\r\n"));
        assert!(!value.contains("Injected/Zone"));
        assert!(!value.contains("attacker@example.test"));
        assert!(value.ends_with("END:VCALENDAR\r\n"));
        assert!(!value.replace("\r\n", "").contains('\n'));
    }
}
