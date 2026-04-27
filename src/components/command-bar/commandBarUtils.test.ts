import { describe, expect, it } from 'vitest';

import type { NoteFile } from '../../types/vault';
import {
  detectMode,
  flattenFiles,
  getTabType,
  getViewForType,
  MODE_PLACEHOLDER,
} from './commandBarUtils';

describe('commandBarUtils', () => {
  it('detects command modes from prefixes and insert shorthands', () => {
    expect(detectMode('= 2+2')).toEqual({ type: 'math', expr: '2+2' });
    expect(detectMode('> open settings')).toEqual({ type: 'action', query: 'open settings' });
    expect(detectMode('tag:project')).toEqual({ type: 'tag', tag: 'project' });
    expect(detectMode('#project')).toEqual({ type: 'tag', tag: 'project' });
    expect(detectMode(':kanban')).toEqual({ type: 'fileType', ext: 'kanban' });
    expect(detectMode('type:md')).toEqual({ type: 'fileType', ext: 'md' });
    expect(detectMode('name:meeting')).toEqual({ type: 'nameSearch', query: 'meeting' });
    expect(detectMode('/table 3x4')).toEqual({ type: 'insert', query: 'table 3x4' });
    expect(detectMode('checklist')).toEqual({ type: 'insert', query: 'checklist' });
    expect(detectMode('plain query')).toEqual({ type: 'search', query: 'plain query' });
  });

  it('maps file types and views correctly', () => {
    expect(getTabType('note.md')).toBe('note');
    expect(getTabType('board.kanban')).toBe('kanban');
    expect(getTabType('map.canvas')).toBe('canvas');
    expect(getTabType('paper.pdf')).toBe('pdf');
    expect(getTabType('cover.png')).toBe('image');

    expect(getViewForType('note')).toBe('editor');
    expect(getViewForType('image')).toBe('editor');
    expect(getViewForType('pdf')).toBe('editor');
    expect(getViewForType('kanban')).toBe('kanban');
    expect(getViewForType('canvas')).toBe('canvas');
  });

  it('flattens nested file trees and exposes placeholders by mode', () => {
    const tree: NoteFile[] = [
      {
        relativePath: 'Folder',
        name: 'Folder',
        extension: '',
        modifiedAt: 0,
        size: 0,
        isFolder: true,
        children: [
          {
            relativePath: 'Folder/note.md',
            name: 'note.md',
            extension: 'md',
            modifiedAt: 1,
            size: 10,
            isFolder: false,
          },
        ],
      },
      {
        relativePath: 'board.kanban',
        name: 'board.kanban',
        extension: 'kanban',
        modifiedAt: 2,
        size: 12,
        isFolder: false,
      },
    ];

    expect(flattenFiles(tree).map((file) => file.relativePath)).toEqual([
      'Folder/note.md',
      'board.kanban',
    ]);
    expect(MODE_PLACEHOLDER.math).toContain('=');
    expect(MODE_PLACEHOLDER.insert).toContain('/table');
  });
});
