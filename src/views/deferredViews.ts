import type { ComponentProps } from 'react';

import { deferredView } from '../components/layout/deferredView';

export const CalendarPage = deferredView(() => import('./CalendarPage'));
export const CanvasPage = deferredView(() => import('./CanvasPage'));
export const ChatsPage = deferredView<
  NonNullable<ComponentProps<typeof import('./ChatsPage').default>>
>(() => import('./ChatsPage'));
export const DeckView = deferredView(() => import('./DeckView'));
export const GraphPage = deferredView<
  NonNullable<ComponentProps<typeof import('./GraphPage').default>>
>(() => import('./GraphPage'));
export const GridView = deferredView(() => import('./GridView'));
export const ImageView = deferredView(() => import('./ImageView'));
export const InkView = deferredView(() => import('./InkView'));
export const KanbanPage = deferredView(() => import('./KanbanPage'));
export const LogicDiagramView = deferredView(() => import('./LogicDiagramView'));
export const NoteView = deferredView(() => import('./NoteView'));
export const NotePrintView = deferredView(() => import('./NotePrintView'));
export const PdfView = deferredView(() => import('./PdfView'));
export const SettingsPage = deferredView(() => import('./SettingsPage'));
export const SheetView = deferredView(() => import('./SheetView'));
export const SvgVectorView = deferredView(() => import('./SvgVectorView'));
