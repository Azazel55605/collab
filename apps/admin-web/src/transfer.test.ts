import { afterEach, describe, expect, it, vi } from 'vitest';

import { transferPercent } from './App';
import { serverApi } from './api';
import {
  downloadWithProgress,
  transferErrorMessage,
  uploadWithProgress,
  type TransferProgress,
} from './transfer';

/** Minimal stand-in for the parts of XMLHttpRequest the uploader uses. */
class FakeXhr {
  static last: FakeXhr | null = null;
  upload: { onprogress?: (event: ProgressEvent) => void; onload?: () => void } = {};
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  status = 200;
  responseText = '';
  withCredentials = false;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  sent: unknown = null;

  constructor() {
    FakeXhr.last = this;
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(key: string, value: string) {
    this.headers[key.toLowerCase()] = value;
  }

  send(body: unknown) {
    this.sent = body;
  }

  /** Drives the request the way a browser would. */
  finish(status: number, responseText: string, loaded: number, total: number | null) {
    this.upload.onprogress?.({
      loaded,
      total: total ?? 0,
      lengthComputable: total !== null,
    } as ProgressEvent);
    this.upload.onload?.();
    this.status = status;
    this.responseText = responseText;
    this.onload?.();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeXhr.last = null;
  document.cookie = 'collab_csrf=; Max-Age=0';
});

describe('uploadWithProgress', () => {
  it('reports bytes as they are sent and resolves with the response data', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const seen: TransferProgress[] = [];
    const archive = new Blob([new Uint8Array(120)]);

    const pending = uploadWithProgress<{ ok: boolean }>('/api/v1/admin/backups/import', archive, {
      csrf: 'csrf-token',
      onProgress: (progress) => seen.push(progress),
    });
    FakeXhr.last!.finish(200, JSON.stringify({ data: { ok: true } }), 60, 120);

    await expect(pending).resolves.toEqual({ ok: true });
    // Progress is a real fraction of a real total, and the final event squares
    // the counter with the body size so a bar cannot stop short of the end.
    expect(seen).toEqual([
      { transferred: 60, total: 120 },
      { transferred: 120, total: 120 },
    ]);
    expect(FakeXhr.last!.headers['content-type']).toBe('application/octet-stream');
    expect(FakeXhr.last!.headers['x-collab-csrf']).toBe('csrf-token');
    expect(FakeXhr.last!.sent).toBe(archive);
    expect(FakeXhr.last!.withCredentials).toBe(true);
  });

  it('reports an unknown upload size as having no total rather than guessing one', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const seen: TransferProgress[] = [];
    const archive = new Blob([new Uint8Array(8)]);

    const pending = uploadWithProgress('/x', archive, { onProgress: (p) => seen.push(p) });
    FakeXhr.last!.finish(200, '', 4, null);
    await pending;

    expect(seen[0]).toEqual({ transferred: 4, total: null });
  });

  it('surfaces the server error message and request id', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const pending = uploadWithProgress('/x', new Blob(['a']), {});
    FakeXhr.last!.finish(
      413,
      JSON.stringify({ error: { message: 'Backup archive is too large.', requestId: 'req-9' } }),
      1,
      1,
    );

    await expect(pending).rejects.toThrow('Backup archive is too large. (req-9)');
  });

  it('is the transport the backup importer uses', async () => {
    // `fetch` cannot report upload progress, so the importer must not be on it.
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    document.cookie = 'collab_csrf=csrf-token';
    const archive = new Blob([new Uint8Array(4)]);

    const pending = serverApi.importBackup(archive, () => {});
    FakeXhr.last!.finish(200, JSON.stringify({ data: {} }), 4, 4);
    await pending;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeXhr.last!.url).toBe('/api/v1/admin/backups/import');
    expect(FakeXhr.last!.sent).toBe(archive);
  });
});

describe('downloadWithProgress', () => {
  function streamed(chunks: Uint8Array[], contentLength: string | null) {
    const headers = new Headers({ 'content-type': 'application/gzip' });
    if (contentLength) headers.set('content-length', contentLength);
    let index = 0;
    return {
      ok: true,
      status: 200,
      headers,
      body: {
        getReader: () => ({
          read: async () =>
            index < chunks.length
              ? { done: false, value: chunks[index++] }
              : { done: true, value: undefined },
        }),
      },
      blob: async () => new Blob(chunks as BlobPart[]),
    };
  }

  it('reports bytes as they arrive against the declared length', async () => {
    const chunks = [new Uint8Array(30), new Uint8Array(70)];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamed(chunks, '100')));
    const seen: TransferProgress[] = [];

    const blob = await downloadWithProgress('/archive', (progress) => seen.push(progress));

    expect(blob.size).toBe(100);
    expect(seen).toEqual([
      { transferred: 30, total: 100 },
      { transferred: 100, total: 100 },
    ]);
  });

  it('reports no total when the response does not declare a length', async () => {
    // A chunked or compressed response has no usable length; the caller shows
    // an indeterminate state rather than a percentage of an unknown whole.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(streamed([new Uint8Array(10)], null)));
    const seen: TransferProgress[] = [];

    await downloadWithProgress('/archive', (progress) => seen.push(progress));

    expect(seen).toEqual([{ transferred: 10, total: null }]);
  });
});

describe('transferErrorMessage', () => {
  it('falls back to the status when the body is not an error envelope', () => {
    expect(transferErrorMessage(500, 'gateway exploded')).toBe('Request failed with 500');
    expect(transferErrorMessage(404, '')).toBe('Request failed with 404');
  });
});

describe('transferPercent', () => {
  it('refuses to produce a percentage without a known total', () => {
    // Server-side packing and unpacking report nothing. Rendering 0% there
    // would read as a stalled transfer rather than as work with no measure.
    expect(transferPercent(null)).toBeNull();
    expect(transferPercent(undefined)).toBeNull();
    expect(transferPercent({ transferred: 500, total: null })).toBeNull();
    expect(transferPercent({ transferred: 5, total: 0 })).toBeNull();
  });

  it('clamps to whole percents inside 0-100', () => {
    expect(transferPercent({ transferred: 0, total: 200 })).toBe(0);
    expect(transferPercent({ transferred: 50, total: 200 })).toBe(25);
    expect(transferPercent({ transferred: 200, total: 200 })).toBe(100);
    // A counter that outran its total must not draw a bar past its own end.
    expect(transferPercent({ transferred: 260, total: 200 })).toBe(100);
  });
});
