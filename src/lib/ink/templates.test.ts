import { beforeEach, describe, expect, it } from 'vitest';

import { createInkPage } from './document';
import { addObject } from './operations';
import {
  createInkTemplate,
  deleteInkTemplate,
  instantiateInkTemplate,
  loadInkTemplates,
  parseInkTemplate,
  saveInkTemplate,
  serializeInkTemplate,
} from './templates';

beforeEach(() => localStorage.clear());

describe('ink document templates', () => {
  it('persists bounded reusable templates', () => {
    const template = createInkTemplate('template-1', 'Meeting paper', createInkPage('page-1'));
    saveInkTemplate(template);
    expect(loadInkTemplates()).toMatchObject([{ id: 'template-1', name: 'Meeting paper' }]);
    expect(deleteInkTemplate('template-1')).toEqual([]);
  });

  it('instantiates a page with fresh layer and object identities', () => {
    const page = createInkPage('page-1');
    const layerId = page.scene.layerOrder[0];
    page.scene = addObject(page.scene, {
      id: 'shape-1', type: 'shape', layerId, shape: 'line', points: [0, 0, 100, 100],
      stroke: { kind: 'technical', color: '#000', opacity: 1, width: 64, thinning: 0, smoothing: 0, streamline: 0, taperStart: 0, taperEnd: 0 },
    }).result;
    const template = createInkTemplate('template-1', 'Lines', page);
    let sequence = 0;
    const instantiated = instantiateInkTemplate(template, 'new-page', (prefix) => `${prefix}-${++sequence}`);
    expect(instantiated.id).toBe('new-page');
    expect(instantiated.scene.layerOrder[0]).not.toBe(layerId);
    expect(instantiated.scene.objectOrder[0]).not.toBe('shape-1');
    expect(instantiated.scene.objects[instantiated.scene.objectOrder[0]].layerId)
      .toBe(instantiated.scene.layerOrder[0]);
  });

  it('round-trips a portable, versioned template and rejects unrelated JSON', () => {
    const template = createInkTemplate('template-1', 'Shared paper', createInkPage('page-1'));
    expect(parseInkTemplate(serializeInkTemplate(template))).toMatchObject({
      id: 'template-1',
      name: 'Shared paper',
      page: { id: 'page-1' },
    });
    expect(() => parseInkTemplate('{"kind":"something-else"}')).toThrow(/not a supported drawing template/i);
  });
});
