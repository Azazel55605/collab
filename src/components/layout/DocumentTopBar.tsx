import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export const documentTopBarGroupClass =
  'flex items-center rounded-xl border border-border/60 bg-card/65 p-1 shadow-sm shadow-black/5';

interface DocumentTopBarProps {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  meta?: ReactNode;
  secondary?: ReactNode;
  className?: string;
  secondaryClassName?: string;
}

export function getDocumentBaseName(relativePath: string | null | undefined, fallback: string) {
  if (!relativePath) return fallback;
  return relativePath.split('/').pop() ?? relativePath;
}

export function getDocumentFolderPath(relativePath: string | null | undefined) {
  if (!relativePath) return 'Vault root';
  const parts = relativePath.split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : 'Vault root';
}

export function DocumentTopBar({
  title,
  subtitle,
  icon,
  meta,
  secondary,
  className,
  secondaryClassName,
}: DocumentTopBarProps) {
  return (
    <div className={cn('shrink-0 border-b border-border/50 bg-background/85 backdrop-blur-xs-webkit', className)}>
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          {icon && <div className="shrink-0 text-muted-foreground">{icon}</div>}
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">{title}</div>
            {subtitle && <div className="truncate text-[11px] text-muted-foreground">{subtitle}</div>}
          </div>
        </div>
        {meta && <div className="flex flex-wrap items-center gap-2">{meta}</div>}
      </div>

      {secondary && (
        <div className="border-t border-border/35 bg-background/72 px-4 py-2.5">
          <div className="-mx-4 overflow-x-auto px-4 scrollbar-none">
            <div className={cn('flex min-w-max items-center gap-2 whitespace-nowrap', secondaryClassName)}>
              {secondary}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
