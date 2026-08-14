import { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import katex from 'katex';
import 'katex/dist/katex.min.css';

import type { InkImage, InkScene, InkText } from '../../types/ink';
import { INK_UNITS_PER_PX } from '../../types/ink';

interface InkRichObjectLayerProps {
  scene: InkScene;
  originX: number;
  originY: number;
  zoom: number;
  readAssetDataUrl: (relativePath: string) => Promise<string>;
}

export default function InkRichObjectLayer({
  scene,
  originX,
  originY,
  zoom,
  readAssetDataUrl,
}: InkRichObjectLayerProps) {
  const images = useMemo(
    () => scene.objectOrder
      .map((id) => scene.objects[id])
      .filter((object): object is InkImage => object?.type === 'image' && scene.layers[object.layerId]?.visible !== false),
    [scene],
  );
  const equations = useMemo(
    () => scene.objectOrder
      .map((id) => scene.objects[id])
      .filter((object): object is InkText => object?.type === 'text' && object.equation === true && scene.layers[object.layerId]?.visible !== false),
    [scene],
  );
  const [sources, setSources] = useState<Record<string, string>>({});
  const sourceCacheRef = useRef(new Map<string, string>());

  useEffect(() => {
    let cancelled = false;
    const paths = [...new Set(images.map((image) => image.relativePath))]
      .filter((path) => !sourceCacheRef.current.has(path));
    const cached = Object.fromEntries(
      images.flatMap((image) => {
        const source = sourceCacheRef.current.get(image.relativePath);
        return source ? [[image.relativePath, source]] : [];
      }),
    );
    if (Object.keys(cached).length > 0) setSources((current) => ({ ...current, ...cached }));
    void Promise.all(paths.map(async (path) => {
      const dataUrl = await readAssetDataUrl(path);
      return [path, sanitizeAssetDataUrl(dataUrl)] as const;
    })).then((entries) => {
      for (const [path, source] of entries) sourceCacheRef.current.set(path, source);
      if (!cancelled) setSources((current) => ({ ...current, ...Object.fromEntries(entries) }));
    }).catch(() => {
      // Keep already resolved assets visible when one new asset fails.
    });
    return () => { cancelled = true; };
  }, [images, readAssetDataUrl]);

  const unitsPerPixel = INK_UNITS_PER_PX / zoom;
  const box = (x: number, y: number, width: number, height: number) => ({
    left: (x - originX) / unitsPerPixel,
    top: (y - originY) / unitsPerPixel,
    width: width / unitsPerPixel,
    height: height / unitsPerPixel,
  });

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      {images.map((object) => {
        const source = sources[object.relativePath];
        if (!source) return null;
        return (
          <img
            key={object.id}
            src={source}
            alt=""
            draggable={false}
            style={{
              position: 'absolute',
              ...box(object.x, object.y, object.width, object.height),
              objectFit: 'contain',
              opacity: object.opacity ?? 1,
              transform: object.rotation ? `rotate(${object.rotation}rad)` : undefined,
              transformOrigin: 'center',
            }}
          />
        );
      })}
      {equations.map((object) => (
        <InkEquationObject
          key={object.id}
          object={object}
          unitsPerPixel={unitsPerPixel}
          originX={originX}
          originY={originY}
        />
      ))}
    </div>
  );
}

function InkEquationObject({
  object,
  unitsPerPixel,
  originX,
  originY,
}: {
  object: InkText;
  unitsPerPixel: number;
  originX: number;
  originY: number;
}) {
  const html = useMemo(() => katex.renderToString(object.text, {
    displayMode: true,
    throwOnError: false,
    trust: false,
    strict: 'warn',
  }), [object.text]);
  return (
    <div
      style={{
        position: 'absolute',
        left: (object.x - originX) / unitsPerPixel,
        top: (object.y - originY) / unitsPerPixel,
        width: object.width / unitsPerPixel,
        height: object.height / unitsPerPixel,
        color: object.color,
        fontSize: Math.max(10, object.fontSize / unitsPerPixel),
        overflow: 'hidden',
        transform: object.rotation ? `rotate(${object.rotation}rad)` : undefined,
        transformOrigin: 'center',
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function sanitizeAssetDataUrl(dataUrl: string): string {
  if (!dataUrl.startsWith('data:image/svg+xml')) return dataUrl;
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return '';
  try {
    const metadata = dataUrl.slice(0, comma);
    const payload = dataUrl.slice(comma + 1);
    const markup = metadata.includes(';base64')
      ? new TextDecoder().decode(Uint8Array.from(atob(payload), (character) => character.charCodeAt(0)))
      : decodeURIComponent(payload);
    const sanitized = DOMPurify.sanitize(markup, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ['script', 'foreignObject'],
      FORBID_ATTR: ['href', 'xlink:href', 'onload', 'onclick'],
    }) as unknown as string;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sanitized)}`;
  } catch {
    return '';
  }
}
