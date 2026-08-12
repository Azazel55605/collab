/**
 * Byte-accurate progress for the two transfers that are actually slow: pushing
 * an archive up and pulling one down.
 *
 * The rest of the admin client uses `fetch`, and it stays that way. `fetch`
 * simply cannot report upload progress — a request body is opaque to the page
 * until the response arrives, and the streaming-request workaround is
 * Chromium-only. Uploads therefore go through `XMLHttpRequest`, which has
 * reported `upload.onprogress` since long before either. Downloads stay on
 * `fetch` and read the response stream, which does work everywhere.
 */

/** A transfer in flight. `total` is absent when the size is not known yet. */
export interface TransferProgress {
  transferred: number;
  total: number | null;
}

export type TransferListener = (progress: TransferProgress) => void;

interface ErrorBody {
  error?: { message?: string; requestId?: string };
}

/** Turns a failed response body into the same message shape `api()` produces. */
export function transferErrorMessage(status: number, body: string): string {
  let parsed: ErrorBody = {};
  try {
    parsed = JSON.parse(body) as ErrorBody;
  } catch {
    parsed = {};
  }
  const suffix = parsed.error?.requestId ? ` (${parsed.error.requestId})` : '';
  return `${parsed.error?.message ?? `Request failed with ${status}`}${suffix}`;
}

/**
 * POSTs a body and reports how much of it has reached the server.
 *
 * `onProgress` stops firing once the last byte is sent; everything after that
 * is the server working, which the caller must represent as indeterminate
 * rather than inventing a percentage for.
 */
export function uploadWithProgress<T>(
  path: string,
  body: Blob,
  options: { method?: string; contentType?: string; csrf?: string; onProgress?: TransferListener },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(options.method ?? 'POST', path, true);
    request.withCredentials = true;
    request.setRequestHeader('content-type', options.contentType ?? 'application/octet-stream');
    if (options.csrf) request.setRequestHeader('x-collab-csrf', options.csrf);

    if (options.onProgress) {
      const onProgress = options.onProgress;
      // `lengthComputable` is false when the size is unknown; reporting the
      // raw counter without a total is honest, inventing one is not.
      request.upload.onprogress = (event) => {
        onProgress({
          transferred: event.loaded,
          total: event.lengthComputable ? event.total : null,
        });
      };
      request.upload.onload = () => {
        onProgress({ transferred: body.size, total: body.size });
      };
    }

    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        const text = request.responseText;
        if (!text || request.status === 204) {
          resolve(undefined as T);
          return;
        }
        try {
          resolve((JSON.parse(text) as { data: T }).data);
        } catch {
          resolve(undefined as T);
        }
        return;
      }
      reject(new Error(transferErrorMessage(request.status, request.responseText)));
    };
    request.onerror = () => reject(new Error('The upload failed before it completed.'));
    request.onabort = () => reject(new Error('The upload was cancelled.'));
    request.ontimeout = () => reject(new Error('The upload timed out.'));
    request.send(body);
  });
}

/**
 * GETs a body and reports how much of it has arrived.
 *
 * Falls back to buffering whole when the response cannot be streamed, so a
 * download never fails merely because progress is unavailable.
 */
export async function downloadWithProgress(
  path: string,
  onProgress?: TransferListener,
): Promise<Blob> {
  const response = await fetch(path, { credentials: 'same-origin' });
  if (!response.ok) {
    throw new Error(transferErrorMessage(response.status, await response.text().catch(() => '')));
  }
  const declared = Number(response.headers.get('content-length'));
  // A compressed or chunked response has no usable length. The caller shows an
  // indeterminate state rather than a percentage of an unknown whole.
  const total = Number.isFinite(declared) && declared > 0 ? declared : null;
  if (!response.body || !onProgress) return response.blob();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let transferred = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    transferred += value.byteLength;
    onProgress({ transferred, total });
  }
  return new Blob(chunks as BlobPart[], {
    type: response.headers.get('content-type') ?? 'application/octet-stream',
  });
}
