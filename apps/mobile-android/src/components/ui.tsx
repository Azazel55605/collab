import type { ReactNode } from 'react';

import {
  CircuitBoard,
  File as FileIcon,
  FileText,
  Folder,
  Image as ImageIcon,
  KanbanSquare,
  Loader2,
  PenLine,
  Shapes,
  Table2,
} from 'lucide-react';

import { type FileGlyph, ROLE_LABEL } from '../lib/format';
import type { MemberRole } from '../mobileTauri';

export function Spinner({ size = 18 }: { size?: number }) {
  return <Loader2 className="spin" size={size} aria-hidden />;
}

export function RoleBadge({ role }: { role: MemberRole }) {
  return <span className={`role-badge role-${role}`}>{ROLE_LABEL[role]}</span>;
}

export function ReadOnlyBadge() {
  return <span className="readonly-badge">Read only</span>;
}

export function StatusDot({ online }: { online: boolean }) {
  return <span className={`status-dot ${online ? 'online' : 'offline'}`} aria-hidden />;
}

export function EmptyState({
  icon,
  title,
  message,
}: {
  icon: ReactNode;
  title: string;
  message: string;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon}</div>
      <strong>{title}</strong>
      <span>{message}</span>
    </div>
  );
}

export function Banner({ tone, children }: { tone: 'error' | 'info'; children: ReactNode }) {
  return <div className={`banner banner-${tone}`}>{children}</div>;
}

export function CacheBadge({ state }: { state: 'cached' | 'stale' | 'uncached' }) {
  if (state === 'cached') return <span className="cache-badge cached">Offline</span>;
  if (state === 'stale') return <span className="cache-badge stale">Update</span>;
  return null;
}

export function ProgressBar({ completed, total }: { completed: number; total: number }) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  return (
    <div className="progress-track" role="progressbar" aria-valuenow={pct}>
      <div className="progress-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function ConfirmSheet({
  title,
  message,
  confirmLabel,
  destructive,
  busy,
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  destructive?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="sheet-backdrop" onClick={onCancel}>
      <div className="sheet" role="dialog" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" />
        <div className="confirm-body">
          <strong>{title}</strong>
          <span>{message}</span>
        </div>
        <div className="form-actions">
          <button type="button" className="ghost-button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className={`primary-button ${destructive ? 'destructive' : ''}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? <Spinner /> : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function GlyphIcon({ glyph, size = 20 }: { glyph: FileGlyph; size?: number }) {
  switch (glyph) {
    case 'folder':
      return <Folder size={size} aria-hidden />;
    case 'note':
      return <FileText size={size} aria-hidden />;
    case 'kanban':
      return <KanbanSquare size={size} aria-hidden />;
    case 'canvas':
      return <Shapes size={size} aria-hidden />;
    case 'logic':
      return <CircuitBoard size={size} aria-hidden />;
    case 'sheet':
      return <Table2 size={size} aria-hidden />;
    case 'ink':
      return <PenLine size={size} aria-hidden />;
    case 'image':
      return <ImageIcon size={size} aria-hidden />;
    case 'pdf':
      return <FileText size={size} aria-hidden />;
    default:
      return <FileIcon size={size} aria-hidden />;
  }
}
