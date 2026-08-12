import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, serverApi } from './api';

describe('admin API client', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.cookie = 'collab_csrf=; Max-Age=0';
  });

  it('sends same-origin credentials and CSRF for mutations', async () => {
    document.cookie = 'collab_csrf=csrf-token';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { ok: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await api('/api/test', { method: 'POST', body: '{}' });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/test',
      expect.objectContaining({
        credentials: 'same-origin',
        method: 'POST',
        headers: expect.any(Headers),
      }),
    );
    const headers = fetchMock.mock.calls[0][1].headers as Headers;
    expect(headers.get('x-collab-csrf')).toBe('csrf-token');
  });

  it('treats an empty 2xx body as a void result', async () => {
    // Adding a group member returns 201 with no body; this must not throw.
    document.cookie = 'collab_csrf=csrf-token';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 201 })));
    await expect(serverApi.addGroupMember('group-1', 'user-1')).resolves.toBeUndefined();
  });

  it('surfaces safe server messages and request IDs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Denied', requestId: 'request-1' } }), {
          status: 403,
        }),
      ),
    );
    await expect(api('/api/test')).rejects.toThrow('Denied (request-1)');
  });

  it('bypasses browser caches when checking whether bootstrap is required', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { required: false } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await serverApi.bootstrapStatus();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/auth/bootstrap-status',
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('uses the hosted vault transfer endpoints from the admin client', async () => {
    document.cookie = 'collab_csrf=csrf-token';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { importedFiles: 1 } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Blob(['zip']), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await serverApi.importVault('vault-1', 'emlw');
    const exported = await serverApi.exportVault('vault-1');

    expect(exported).toBeInstanceOf(Blob);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/vaults/vault-1/import');
    expect(fetchMock.mock.calls[1]).toEqual([
      '/api/v1/vaults/vault-1/export',
      { credentials: 'same-origin' },
    ]);
    const importHeaders = fetchMock.mock.calls[0][1].headers as Headers;
    expect(importHeaders.get('x-collab-csrf')).toBe('csrf-token');
  });
});
