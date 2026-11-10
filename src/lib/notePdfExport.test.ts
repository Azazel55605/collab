import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildNotePdfExportRoute,
  NOTE_PDF_EXPORT_EVENT,
  requestNotePdfExport,
} from './notePdfExport';

describe('notePdfExport', () => {
  it('includes an unsaved snapshot when exporting from the editor', () => {
    const handler = vi.fn();
    window.addEventListener(NOTE_PDF_EXPORT_EVENT, handler as EventListener);
    requestNotePdfExport('Note.md', 'latest unsaved text');
    expect(handler.mock.calls[0][0].detail).toEqual({
      relativePath: 'Note.md',
      contentSnapshot: 'latest unsaved text',
    });
    window.removeEventListener(NOTE_PDF_EXPORT_EVENT, handler as EventListener);
  });
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('builds a print-note route from the current app path', () => {
    expect(buildNotePdfExportRoute('Notes/My Note.md')).toBe('/?print-note=Notes%2FMy+Note.md');
  });

  it('dispatches an in-app export request for the note', () => {
    const handler = vi.fn();
    window.addEventListener(NOTE_PDF_EXPORT_EVENT, handler as EventListener);

    requestNotePdfExport('Notes/My Note.md');

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0]?.[0] as CustomEvent<{ relativePath: string }>;
    expect(event.detail).toEqual({ relativePath: 'Notes/My Note.md' });

    window.removeEventListener(NOTE_PDF_EXPORT_EVENT, handler as EventListener);
  });
});
