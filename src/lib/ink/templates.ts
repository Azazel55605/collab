import type { InkPage } from '../../types/ink';
import { createInkDocument, normalizeInkDocument } from './document';

const STORAGE_KEY = 'collab-ink-templates-v1';
const MAX_TEMPLATES = 20;
const MAX_STORAGE_BYTES = 4 * 1024 * 1024;
const TEMPLATE_KIND = 'collab-ink-template';
const TEMPLATE_SCHEMA_VERSION = 1;

export interface InkDocumentTemplate {
  id: string;
  name: string;
  createdAt: string;
  page: InkPage;
}

interface PortableInkTemplate {
  kind: typeof TEMPLATE_KIND;
  schemaVersion: typeof TEMPLATE_SCHEMA_VERSION;
  template: InkDocumentTemplate;
}

export function loadInkTemplates(): InkDocumentTemplate[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isTemplate).slice(0, MAX_TEMPLATES);
  } catch {
    return [];
  }
}

export function saveInkTemplate(template: InkDocumentTemplate): InkDocumentTemplate[] {
  const templates = [template, ...loadInkTemplates().filter((entry) => entry.id !== template.id)]
    .slice(0, MAX_TEMPLATES);
  persist(templates);
  return templates;
}

export function deleteInkTemplate(templateId: string): InkDocumentTemplate[] {
  const templates = loadInkTemplates().filter((entry) => entry.id !== templateId);
  persist(templates);
  return templates;
}

export function createInkTemplate(id: string, name: string, page: InkPage): InkDocumentTemplate {
  return {
    id,
    name: name.trim() || 'Drawing template',
    createdAt: new Date().toISOString(),
    page: structuredClone(page),
  };
}

export function instantiateInkTemplate(
  template: InkDocumentTemplate,
  pageId: string,
  makeId: (prefix: string) => string,
): InkPage {
  const page = structuredClone(template.page);
  const layerIds = new Map(page.scene.layerOrder.map((id) => [id, makeId('layer')]));
  const objectIds = new Map(page.scene.objectOrder.map((id) => [id, makeId('object')]));

  const layers = Object.fromEntries(page.scene.layerOrder.map((oldId) => {
    const id = layerIds.get(oldId)!;
    return [id, { ...page.scene.layers[oldId], id }];
  }));
  const objects = Object.fromEntries(page.scene.objectOrder.map((oldId) => {
    const object = page.scene.objects[oldId];
    const id = objectIds.get(oldId)!;
    const layerId = layerIds.get(object.layerId) ?? [...layerIds.values()][0];
    const remapped = { ...object, id, layerId };
    if (remapped.type === 'group') {
      remapped.childIds = remapped.childIds.flatMap((childId) => {
        const mapped = objectIds.get(childId);
        return mapped ? [mapped] : [];
      });
    }
    if (remapped.type === 'connector') {
      if (remapped.from.objectId) remapped.from.objectId = objectIds.get(remapped.from.objectId);
      if (remapped.to.objectId) remapped.to.objectId = objectIds.get(remapped.to.objectId);
    }
    return [id, remapped];
  }));

  return {
    ...page,
    id: pageId,
    name: template.name,
    scene: {
      layers,
      layerOrder: page.scene.layerOrder.map((id) => layerIds.get(id)!),
      objects,
      objectOrder: page.scene.objectOrder.map((id) => objectIds.get(id)!),
    },
  };
}

export function serializeInkTemplate(template: InkDocumentTemplate): string {
  return `${JSON.stringify({
    kind: TEMPLATE_KIND,
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
    template,
  } satisfies PortableInkTemplate, null, 2)}\n`;
}

export function parseInkTemplate(text: string): InkDocumentTemplate {
  if (new Blob([text]).size > MAX_STORAGE_BYTES) {
    throw new Error('Drawing template exceeds the 4 MB import budget.');
  }
  const payload = JSON.parse(text) as Partial<PortableInkTemplate>;
  if (payload.kind !== TEMPLATE_KIND || payload.schemaVersion !== TEMPLATE_SCHEMA_VERSION || !isTemplate(payload.template)) {
    throw new Error('This file is not a supported drawing template.');
  }

  const shell = createInkDocument({ name: payload.template.name, timestamp: payload.template.createdAt });
  const inspection = normalizeInkDocument({
    ...shell,
    pages: { [payload.template.page.id]: payload.template.page },
    pageOrder: [payload.template.page.id],
  });
  if (inspection.support !== 'supported') {
    throw new Error('This drawing template requires a newer Collab version.');
  }
  return {
    ...payload.template,
    page: inspection.document.pages[inspection.document.pageOrder[0]],
  };
}

function persist(templates: InkDocumentTemplate[]): void {
  const serialized = JSON.stringify(templates);
  if (new Blob([serialized]).size > MAX_STORAGE_BYTES) {
    throw new Error('Drawing templates exceed the 4 MB local storage budget.');
  }
  localStorage.setItem(STORAGE_KEY, serialized);
}

function isTemplate(value: unknown): value is InkDocumentTemplate {
  if (!value || typeof value !== 'object') return false;
  const source = value as Record<string, unknown>;
  const page = source.page as Record<string, unknown> | undefined;
  return typeof source.id === 'string'
    && typeof source.name === 'string'
    && typeof source.createdAt === 'string'
    && !!page
    && typeof page.id === 'string'
    && typeof page.scene === 'object';
}
