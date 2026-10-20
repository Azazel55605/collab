import { GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';

// Keep the compatibility API and its matching worker paired on all surfaces.
GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/legacy/build/pdf.worker.mjs',
  import.meta.url,
).toString();

export {
  getDocument,
  PixelsPerInch,
  RenderingCancelledException,
  TextLayer,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
export type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs';
