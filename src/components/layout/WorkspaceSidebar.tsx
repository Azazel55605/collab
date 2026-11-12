import type { ComponentPropsWithoutRef } from 'react';

import { cn } from '../../lib/utils';

type WorkspaceSidebarProps = ComponentPropsWithoutRef<'aside'> & {
  open?: boolean;
  frameClassName?: string;
};

export function WorkspaceSidebar({ open, frameClassName, ...asideProps }: WorkspaceSidebarProps) {
  const panel = <aside {...asideProps} />;
  if (open === undefined) return panel;

  return (
    <div
      className={cn(
        'app-workspace-sidebar app-motion-base transition-[width,opacity] motion-reduce:transition-none',
        frameClassName,
      )}
      aria-hidden={!open}
      inert={!open}
    >
      {panel}
    </div>
  );
}
