import { normalizeWebPreviewUrl } from '../../lib/webPreviewCache';
import type { LinkPreviewData } from '../../lib/tauri';
import type { CanvasNode, CanvasWebDisplayMode, WebCanvasNode } from '../../types/canvas';
import type { CanvasWebCardDefaultMode } from '../../store/uiStore';

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
const TEXT_PREVIEW_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'yml', 'yaml', 'toml', 'csv', 'ts', 'tsx',
  'js', 'jsx', 'css', 'html', 'rs', 'py', 'sh', 'sql', 'xml',
]);

export interface PreviewState {
  excerpt?: string;
  imageSrc?: string | null;
  faviconSrc?: string | null;
  markdownContent?: string;
  linkPreview?: LinkPreviewData | null;
  embedAvailable?: boolean;
  embedChecked?: boolean;
  previewError?: string | null;
  loading?: boolean;
  loaded?: boolean;
}

function getBaseName(relativePath: string): string {
  return relativePath.split('/').pop() ?? relativePath;
}

export { getBaseName };

function getNameWithoutExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

function getFileSubtitle(relativePath: string): string | undefined {
  const parts = relativePath.split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : undefined;
}

export function cleanPreviewText(content: string): string {
  const withoutFrontmatter = content.replace(/^---[\s\S]*?---\s*/m, '');
  const plain = withoutFrontmatter
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#>*`~_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.slice(0, 220);
}

export function isImageExtension(extension: string): boolean {
  return IMAGE_EXTENSIONS.has(extension.toLowerCase());
}

export function canPreviewText(extension: string): boolean {
  return TEXT_PREVIEW_EXTENSIONS.has(extension.toLowerCase());
}

export function normalizeWebUrl(value: string) {
  return normalizeWebPreviewUrl(value);
}

export function getPreviewKey(node: CanvasNode) {
  if ('relativePath' in node) return `vault:${node.relativePath}`;
  if (node.type === 'web') return `web:${normalizeWebUrl(node.url)}`;
  return `node:${node.id}`;
}

export function resolveWebDisplayMode(
  override: CanvasWebDisplayMode | null | undefined,
  defaultMode: CanvasWebCardDefaultMode,
) {
  return override ?? defaultMode;
}

export function buildNodePreviewState(
  node: Extract<CanvasNode, { relativePath: string }>,
  preview: PreviewState | undefined,
) {
  const title = getNameWithoutExtension(getBaseName(node.relativePath));
  const subtitle = getFileSubtitle(node.relativePath) ?? node.relativePath;
  return {
    title,
    subtitle,
    excerpt: preview?.excerpt,
    imageSrc: preview?.imageSrc ?? null,
    markdownContent: preview?.markdownContent,
    relativePath: node.relativePath,
    extension: node.relativePath.split('.').pop()?.toLowerCase(),
  };
}

export function buildWebPreviewState(
  node: WebCanvasNode,
  preview: PreviewState | undefined,
  defaultMode: CanvasWebCardDefaultMode,
  autoLoadEnabled: boolean,
  webPreviewsEnabled: boolean,
) {
  const normalizedUrl = normalizeWebUrl(node.url);
  const hostname = (() => {
    try {
      return normalizedUrl ? new URL(normalizedUrl).hostname : 'Add a website';
    } catch {
      return node.url || 'Add a website';
    }
  })();
  const fallbackPath = (() => {
    try {
      if (!normalizedUrl) return '';
      const parsed = new URL(normalizedUrl);
      return `${parsed.pathname}${parsed.search}${parsed.hash}`.trim() || '/';
    } catch {
      return '';
    }
  })();
  const linkPreview = preview?.linkPreview;
  const hasMetadataTitle = Boolean(linkPreview?.title?.trim());
  const hasMetadataDescription = Boolean(linkPreview?.description?.trim());
  const hasMetadataImage = Boolean(linkPreview?.imageUrl);
  const hasMetadataSiteName = Boolean(linkPreview?.siteName?.trim() && linkPreview.siteName?.trim() !== hostname);
  const hasRichPreview = hasMetadataTitle || hasMetadataDescription || hasMetadataImage || hasMetadataSiteName;
  const fallbackExcerpt = preview?.previewError
    ? `Preview unavailable right now. ${preview.previewError}`
    : normalizedUrl
      ? `This site does not expose much preview metadata. We are showing the link details instead${fallbackPath && fallbackPath !== '/' ? ` for ${fallbackPath}` : ''}.`
      : 'Enter a URL to load a website preview.';
  return {
    title: linkPreview?.title || hostname,
    subtitle: linkPreview?.siteName || normalizedUrl || hostname,
    excerpt: linkPreview?.description ?? linkPreview?.embedBlockReason ?? fallbackExcerpt,
    imageSrc: linkPreview?.imageUrl ?? null,
    faviconSrc: linkPreview?.faviconUrl ?? null,
    hasRichPreview,
    previewError: preview?.previewError ?? null,
    previewLoading: preview?.loading ?? false,
    previewLoaded: preview?.loaded ?? false,
    previewAutoLoadEnabled: autoLoadEnabled,
    webPreviewsEnabled,
    embedAvailable: linkPreview?.embeddable ?? preview?.embedAvailable,
    url: node.url,
    displayMode: resolveWebDisplayMode(node.displayModeOverride, defaultMode),
    displayModeOverride: node.displayModeOverride ?? null,
  };
}
