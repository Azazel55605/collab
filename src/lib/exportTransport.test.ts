import { expect, it } from 'vitest';

import { admitExport, packExport, unpackExport } from './exportTransport';

it('round trips Unicode snapshots and embedded assets through transfer buffers', () => {
  const document = {
    name: 'Résumé 数学',
    values: Array.from({ length: 10000 }, (_, i) => ({ id: i, value: i * 2 })),
  };
  const packet = packExport(document, {
    picture: 'data:image/png;base64,AAECAw==',
    svg: 'data:image/svg+xml,%3Csvg%3E%C3%A9%3C/svg%3E',
  });
  const transferred = structuredClone(
    { json: packet.json, assets: packet.assets },
    { transfer: packet.transfers },
  );
  expect(packet.json.byteLength).toBe(0);
  const restored = unpackExport<typeof document>(transferred);
  expect(restored.metadata).toEqual(document);
  expect(restored.assets.picture).toBe('data:image/png;base64,AAECAw==');
  expect(
    new TextDecoder().decode(
      Uint8Array.from(atob(restored.assets.svg.split(',')[1]), (c) => c.charCodeAt(0)),
    ),
  ).toBe('<svg>é</svg>');
});
it('bounds concurrent exports and releases admission exactly once', () => {
  const a = admitExport(),
    b = admitExport();
  expect(() => admitExport()).toThrow('Two exports');
  a();
  a();
  const c = admitExport();
  b();
  c();
});
