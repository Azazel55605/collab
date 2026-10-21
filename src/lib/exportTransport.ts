/** Transfer immutable export snapshots as owned binary buffers, not cloned object trees. */
export interface PackedAsset {
  prefix: string;
  bytes: Uint8Array;
}
export interface ExportPacket {
  json: Uint8Array;
  assets: Record<string, PackedAsset>;
  transfers: ArrayBuffer[];
}
export const EXPORT_PAYLOAD_BYTES = 128 * 1024 * 1024;
export function packExport(metadata: unknown, assets: Record<string, string> = {}): ExportPacket {
  const source = JSON.stringify(metadata);
  if (source.length * 2 > 64 * 1024 * 1024)
    throw new Error('Export document exceeds its 64 MiB snapshot budget');
  const json = new TextEncoder().encode(source);
  const packed: Record<string, PackedAsset> = {};
  let bytes = json.byteLength;
  for (const [key, url] of Object.entries(assets)) {
    const comma = url.indexOf(',');
    if (comma < 0 || !url.startsWith('data:'))
      throw new Error('Export assets must be embedded data URLs');
    const prefix = url.slice(0, comma);
    const data = prefix.includes(';base64')
      ? Uint8Array.from(atob(url.slice(comma + 1)), (c) => c.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(url.slice(comma + 1)));
    bytes += data.byteLength;
    if (bytes > EXPORT_PAYLOAD_BYTES)
      throw new Error('Export exceeds its 128 MiB binary payload budget');
    packed[key] = { prefix: prefix.replace(/;base64$/, ''), bytes: data };
  }
  return {
    json,
    assets: packed,
    transfers: [
      json.buffer,
      ...Object.values(packed).map((asset) => asset.bytes.buffer),
    ] as ArrayBuffer[],
  };
}
export function unpackExport<T>(packet: Omit<ExportPacket, 'transfers'>): {
  metadata: T;
  assets: Record<string, string>;
} {
  let bytes = packet.json.byteLength;
  if (bytes > EXPORT_PAYLOAD_BYTES) throw new Error('Export payload exceeds its budget');
  const assets: Record<string, string> = {};
  for (const [key, asset] of Object.entries(packet.assets)) {
    bytes += asset.bytes.byteLength;
    if (bytes > EXPORT_PAYLOAD_BYTES) throw new Error('Export payload exceeds its budget');
    let binary = '';
    for (let i = 0; i < asset.bytes.length; i += 0x8000)
      binary += String.fromCharCode(...asset.bytes.subarray(i, i + 0x8000));
    assets[key] = `${asset.prefix};base64,${btoa(binary)}`;
  }
  return { metadata: JSON.parse(new TextDecoder().decode(packet.json)) as T, assets };
}
let active = 0;
export function admitExport() {
  if (active >= 2)
    throw new Error('Two exports are already running. Wait or cancel one before exporting again.');
  active++;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      active--;
    }
  };
}
