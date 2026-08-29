import type { ReactNode } from 'react';

import {
  Diamond,
  FileText,
  Flag,
  Globe,
  PencilLine,
  Plus,
  Route,
  Shapes,
  Users,
} from 'lucide-react';

import type { CanvasNodeType, PlanningCanvasNode } from '../../types/canvas';

export type CanvasInsertItem =
  | { id: 'note'; label: string; keywords: string; group: 'Content'; icon: ReactNode }
  | { id: 'file'; label: string; keywords: string; group: 'Content'; icon: ReactNode }
  | { id: 'text'; label: string; keywords: string; group: 'Content'; icon: ReactNode }
  | { id: 'web'; label: string; keywords: string; group: 'Content'; icon: ReactNode }
  | { id: 'symbol'; label: string; keywords: string; group: 'Content'; icon: ReactNode }
  | {
      id: PlanningCanvasNode['type'];
      label: string;
      keywords: string;
      group: 'Flow' | 'Planning' | 'Structure';
      icon: ReactNode;
    };

export const CANVAS_INSERTABLE_CONTENT_TYPES = [
  'note',
  'file',
  'text',
  'web',
  'symbol',
] as const satisfies CanvasNodeType[];

export const canvasInsertItems: CanvasInsertItem[] = [
  {
    id: 'note',
    label: 'Note',
    keywords: 'markdown vault document',
    group: 'Content',
    icon: <FileText size={14} />,
  },
  {
    id: 'file',
    label: 'File',
    keywords: 'asset pdf image attachment',
    group: 'Content',
    icon: <FileText size={14} />,
  },
  {
    id: 'text',
    label: 'Text',
    keywords: 'sticky quick note plain text',
    group: 'Content',
    icon: <PencilLine size={14} />,
  },
  {
    id: 'web',
    label: 'Web',
    keywords: 'url link website preview',
    group: 'Content',
    icon: <Globe size={14} />,
  },
  {
    id: 'symbol',
    label: 'Symbol',
    keywords: 'icon glyph nerd font symbol',
    group: 'Content',
    icon: <Shapes size={14} />,
  },
  {
    id: 'process',
    label: 'Process',
    keywords: 'step action task workflow',
    group: 'Flow',
    icon: <Route size={14} />,
  },
  {
    id: 'decision',
    label: 'Decision',
    keywords: 'if else branch condition',
    group: 'Flow',
    icon: <Diamond size={14} />,
  },
  {
    id: 'terminator',
    label: 'Start / End',
    keywords: 'begin finish end terminator',
    group: 'Flow',
    icon: <Flag size={14} />,
  },
  {
    id: 'junction',
    label: 'Junction',
    keywords: 'connector split merge',
    group: 'Flow',
    icon: <Plus size={14} />,
  },
  {
    id: 'crossing',
    label: 'Crossing',
    keywords: 'bridge crossover routing',
    group: 'Flow',
    icon: <Route size={14} />,
  },
  {
    id: 'milestone',
    label: 'Milestone',
    keywords: 'checkpoint deadline release',
    group: 'Planning',
    icon: <Flag size={14} />,
  },
  {
    id: 'actor',
    label: 'Actor',
    keywords: 'owner person team role',
    group: 'Planning',
    icon: <Users size={14} />,
  },
  {
    id: 'document',
    label: 'Document',
    keywords: 'spec brief reference artifact',
    group: 'Planning',
    icon: <FileText size={14} />,
  },
  {
    id: 'swimlane',
    label: 'Swimlane',
    keywords: 'lane owner phase row column',
    group: 'Structure',
    icon: <Route size={14} />,
  },
  {
    id: 'group',
    label: 'Group',
    keywords: 'container cluster section',
    group: 'Structure',
    icon: <Route size={14} />,
  },
];
