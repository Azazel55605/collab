import { describe, expect, it } from 'vitest';
import { createCalendarDefinition, normalizeCalendarItem } from '../types/calendar';
import {
  exportCalendarIcs,
  MAX_ICS_ITEMS,
  previewCalendarIcsImport,
} from './calendarIcs';

const calendar = createCalendarDefinition({
  id: 'calendar-1',
  location: { kind: 'local', profileId: 'profile-1' },
  name: 'Personal',
  color: '#a78bfa',
  defaultTimeZone: 'Europe/Berlin',
  now: '2026-07-26T10:00:00.000Z',
});

const fixture = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'X-WR-CALNAME:Imported',
  'BEGIN:VEVENT',
  'UID:event-1@example.test',
  'SUMMARY:Planning',
  'DESCRIPTION:Quarterly planning',
  'ATTENDEE;CN=Alex;PARTSTAT=ACCEPTED:mailto:alex@example.test',
  'DTSTART:20260727T090000Z',
  'DTEND:20260727T100000Z',
  'RRULE:FREQ=WEEKLY;COUNT=3',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'TRIGGER:-PT15M',
  'END:VALARM',
  'END:VEVENT',
  'BEGIN:VTODO',
  'UID:task-1@example.test',
  'SUMMARY:Send notes',
  'DUE;VALUE=DATE:20260728',
  'STATUS:NEEDS-ACTION',
  'PRIORITY:1',
  'END:VTODO',
  'END:VCALENDAR',
].join('\r\n');

describe('iCalendar interoperability', () => {
  it('previews bounded events and tasks with alarms and recurrence', () => {
    const preview = previewCalendarIcsImport(fixture, calendar, [], '2026-07-26T11:00:00.000Z');

    expect(preview).toMatchObject({
      calendarName: 'Imported',
      creates: 2,
      updates: 0,
      unchanged: 0,
      conflicts: 0,
    });
    expect(preview.entries[0].item).toMatchObject({
      kind: 'event',
      uid: 'event-1@example.test',
      title: 'Planning',
      recurrence: { rrule: 'FREQ=WEEKLY;COUNT=3' },
      reminders: [{ kind: 'relative', minutesBefore: 15 }],
      attendees: [{ kind: 'email', email: 'alex@example.test', response: 'accepted' }],
    });
    expect(preview.entries[1].item).toMatchObject({
      kind: 'task',
      due: { kind: 'date', date: '2026-07-28' },
      priority: 'high',
      status: 'needs-action',
    });
  });

  it('deduplicates by UID and recurrence identity and preserves the existing id on updates', () => {
    const initial = previewCalendarIcsImport(fixture, calendar, [], '2026-07-26T11:00:00.000Z');
    const existing = initial.entries.map((entry, index) => normalizeCalendarItem({
      ...entry.item,
      id: `stored-${index}`,
      revision: 4,
      createdAt: '2026-07-20T10:00:00.000Z',
    }));
    const unchanged = previewCalendarIcsImport(fixture, calendar, existing, '2026-07-26T11:00:00.000Z');
    expect(unchanged.unchanged).toBe(2);

    const changedFixture = fixture.replace('SUMMARY:Planning', 'SUMMARY:Revised planning');
    const changed = previewCalendarIcsImport(changedFixture, calendar, existing, '2026-07-26T12:00:00.000Z');
    expect(changed.updates).toBe(1);
    expect(changed.entries.find((entry) => entry.action === 'update')?.item).toMatchObject({
      id: 'stored-0',
      revision: 5,
      title: 'Revised planning',
    });
  });

  it('exports valid CRLF iCalendar that round-trips supported fields', () => {
    const imported = previewCalendarIcsImport(fixture, calendar, []).entries.map((entry) => entry.item);
    const exported = exportCalendarIcs(calendar, imported);
    const reparsed = previewCalendarIcsImport(exported, calendar, []);

    expect(exported).toContain('\r\nBEGIN:VEVENT\r\n');
    expect(reparsed.creates).toBe(2);
    expect(reparsed.entries.map((entry) => entry.item.uid)).toEqual([
      'event-1@example.test',
      'task-1@example.test',
    ]);
    expect(reparsed.entries[0].item.reminders).toEqual([{ kind: 'relative', minutesBefore: 15 }]);
    expect(reparsed.entries[0].item.attendees).toMatchObject([{ email: 'alex@example.test' }]);
  });

  it('preserves Collab time-zone semantics while exporting UTC instants', () => {
    const item = normalizeCalendarItem({
      id: 'event-zoned',
      uid: 'event-zoned@example.test',
      calendarId: calendar.id,
      kind: 'event',
      title: 'Berlin meeting',
      reminders: [],
      attendees: [],
      attachments: [],
      start: { kind: 'dateTime', dateTime: '2026-07-27T07:00:00.000Z', timeZone: 'Europe/Berlin' },
      end: { kind: 'dateTime', dateTime: '2026-07-27T08:00:00.000Z', timeZone: 'Europe/Berlin' },
      availability: 'busy',
      revision: 0,
      createdAt: '2026-07-26T10:00:00.000Z',
      updatedAt: '2026-07-26T10:00:00.000Z',
    });
    const reparsed = previewCalendarIcsImport(exportCalendarIcs(calendar, [item]), calendar, []);
    expect(reparsed.entries[0].item).toMatchObject({
      start: { dateTime: '2026-07-27T07:00:00.000Z', timeZone: 'Europe/Berlin' },
      end: { dateTime: '2026-07-27T08:00:00.000Z', timeZone: 'Europe/Berlin' },
    });
  });

  it('preserves safe provider extensions without accepting Collab overrides', () => {
    const providerFixture = fixture.replace(
      'DTSTART:20260727T090000Z',
      [
        'X-MICROSOFT-CDO-BUSYSTATUS:BUSY',
        'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC',
        'X-GOOGLE-CONFERENCE:https://meet.example.test/room',
        'X-COLLAB-START-TIMEZONE:Injected/Zone',
        'DTSTART:20260727T090000Z',
      ].join('\r\n'),
    );
    const imported = previewCalendarIcsImport(providerFixture, calendar, []).entries[0].item;
    expect(imported.icalendarProperties).toEqual([
      'X-MICROSOFT-CDO-BUSYSTATUS:BUSY',
      'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC',
      'X-GOOGLE-CONFERENCE:https://meet.example.test/room',
    ]);

    const reparsed = previewCalendarIcsImport(
      exportCalendarIcs(calendar, [imported]),
      calendar,
      [],
    ).entries[0].item;
    expect(reparsed.icalendarProperties).toEqual(imported.icalendarProperties);
    expect(exportCalendarIcs(calendar, [imported])).not.toContain('Injected/Zone');
  });

  it('handles representative Outlook and Apple timezone fixtures across DST', () => {
    const zonedFixture = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'BEGIN:VTIMEZONE',
      'TZID:America/New_York',
      'BEGIN:STANDARD',
      'DTSTART:19701101T020000',
      'TZOFFSETFROM:-0400',
      'TZOFFSETTO:-0500',
      'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU',
      'END:STANDARD',
      'BEGIN:DAYLIGHT',
      'DTSTART:19700308T020000',
      'TZOFFSETFROM:-0500',
      'TZOFFSETTO:-0400',
      'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU',
      'END:DAYLIGHT',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'UID:outlook-dst@example.test',
      'SUMMARY:Outlook DST',
      'DTSTART;TZID=America/New_York:20261101T013000',
      'DTEND;TZID=America/New_York:20261101T023000',
      'X-MICROSOFT-CDO-ALLDAYEVENT:FALSE',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:apple-all-day@example.test',
      'SUMMARY:Apple holiday',
      'DTSTART;VALUE=DATE:20261224',
      'DTEND;VALUE=DATE:20261225',
      'X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:DISABLED',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const preview = previewCalendarIcsImport(zonedFixture, calendar, []);
    expect(preview).toMatchObject({ creates: 2, conflicts: 0 });
    expect(preview.entries[0].item).toMatchObject({
      start: { timeZone: 'America/New_York' },
      icalendarProperties: ['X-MICROSOFT-CDO-ALLDAYEVENT:FALSE'],
    });
    expect(preview.entries[1].item).toMatchObject({
      start: { kind: 'date', date: '2026-12-24' },
      icalendarProperties: ['X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:DISABLED'],
    });
  });

  it('rejects malformed, injected, and reserved preserved properties during normalization', () => {
    const input = {
      ...previewCalendarIcsImport(fixture, calendar, []).entries[0].item,
      icalendarProperties: [
        'X-SAFE-PROPERTY:value',
        'X-COLLAB-START-TIMEZONE:Injected/Zone',
        'X-BROKEN:value\r\nATTENDEE:mailto:attacker@example.test',
        'SUMMARY:Replacement',
      ],
    };
    expect(() => normalizeCalendarItem(input)).toThrow(/safe X-\*/);
    expect(normalizeCalendarItem({
      ...input,
      icalendarProperties: ['X-SAFE-PROPERTY:value'],
    }).icalendarProperties).toEqual(['X-SAFE-PROPERTY:value']);
  });

  it('rejects oversized item collections before application', () => {
    const items = Array.from({ length: MAX_ICS_ITEMS + 1 }, (_, index) => [
      'BEGIN:VEVENT',
      `UID:${index}@example.test`,
      `SUMMARY:${index}`,
      'DTSTART;VALUE=DATE:20260727',
      'END:VEVENT',
    ].join('\r\n')).join('\r\n');
    expect(() => previewCalendarIcsImport(
      `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${items}\r\nEND:VCALENDAR`,
      calendar,
      [],
    )).toThrow(/more than/);
  });
});
