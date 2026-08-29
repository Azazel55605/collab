export const NOTE_PDF_EXPORT_EVENT = 'note-pdf-export';

export function buildNotePdfExportRoute(relativePath: string) {
  const basePath = window.location.pathname || '/';
  const params = new URLSearchParams();
  params.set('print-note', relativePath);
  return `${basePath}?${params.toString()}`;
}

export function requestNotePdfExport(relativePath: string) {
  window.dispatchEvent(
    new CustomEvent<{ relativePath: string }>(NOTE_PDF_EXPORT_EVENT, {
      detail: { relativePath },
    }),
  );
}
