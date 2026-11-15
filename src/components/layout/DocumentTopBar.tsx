import {
  Children,
  type ComponentProps,
  Fragment,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { ChevronDown, MoreHorizontal } from 'lucide-react';

import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

/**
 * A group of related tools in the document tool strip. Groups are flat and
 * separated by a thin divider (see `.doc-toolstrip` in App.css), never boxed.
 */
export const documentTopBarGroupClass = 'doc-strip-group flex items-center gap-0.5 px-1.5';
export const documentTopBarButtonClass = 'h-8 gap-1.5 px-2.5 text-[13px]';
export const documentTopBarIconButtonClass = 'size-8';

interface DocumentTopBarProps {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  /** Save/sync state, shown right after the title. */
  status?: ReactNode;
  /** Right side: people, view switch, the primary action and the ⋯ menu. */
  meta?: ReactNode;
  /** The single tool strip below the header. Overflowing groups fold into "More". */
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

export function DocumentTopBarButton({
  className,
  size = 'sm',
  variant = 'ghost',
  ...props
}: ComponentProps<typeof Button>) {
  return (
    <Button
      size={size}
      variant={variant}
      className={cn(documentTopBarButtonClass, className)}
      {...props}
    />
  );
}

export function DocumentTopBarIconButton({
  className,
  size = 'icon',
  variant = 'ghost',
  ...props
}: ComponentProps<typeof Button>) {
  return (
    <Button
      size={size}
      variant={variant}
      className={cn(documentTopBarIconButtonClass, className)}
      {...props}
    />
  );
}

/** A labelled tool-strip button that opens a menu, e.g. "Insert ▾". */
export function DocumentTopBarMenuButton({
  children,
  className,
  ...props
}: ComponentProps<typeof Button>) {
  return (
    <DocumentTopBarButton className={cn('pr-1.5', className)} {...props}>
      {children}
      <ChevronDown className="size-3.5 opacity-70" aria-hidden="true" />
    </DocumentTopBarButton>
  );
}

/** The header's ⋯ menu for rarely used document actions (export, print, properties…). */
export function DocumentMoreMenu({
  label = 'More actions',
  children,
}: {
  label?: string;
  children: ReactNode;
}) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <DocumentTopBarIconButton aria-label={label} title={label}>
          <MoreHorizontal />
        </DocumentTopBarIconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function DocumentTopBar({
  title,
  subtitle,
  icon,
  status,
  meta,
  secondary,
  className,
  secondaryClassName,
}: DocumentTopBarProps) {
  return (
    <div className={cn('shrink-0 border-b border-border/60 bg-background', className)}>
      <div className="flex min-h-12 flex-wrap items-center gap-x-2.5 gap-y-1 py-1.5 pr-2.5 pl-4">
        {icon && <div className="shrink-0 text-muted-foreground [&_svg]:size-4">{icon}</div>}
        <div className="flex min-w-0 items-baseline gap-2">
          <div className="truncate text-sm font-semibold text-foreground">{title}</div>
          {subtitle && (
            <div className="hidden truncate text-xs text-muted-foreground sm:block">{subtitle}</div>
          )}
        </div>
        {status ? <div className="flex shrink-0 items-center">{status}</div> : null}
        {meta && <div className="ml-auto flex flex-wrap items-center gap-1.5">{meta}</div>}
      </div>

      {secondary && (
        <DocumentToolStrip className={cn('border-t border-border/50', secondaryClassName)}>
          {secondary}
        </DocumentToolStrip>
      )}
    </div>
  );
}

function flattenChildren(children: ReactNode): ReactNode[] {
  return Children.toArray(children).flatMap((child) =>
    isValidElement(child) && child.type === Fragment
      ? flattenChildren((child as ReactElement<{ children?: ReactNode }>).props.children)
      : [child],
  );
}

const MORE_BUTTON_WIDTH = 88;

/**
 * A single row of tool groups. Instead of scrolling sideways, groups that do not
 * fit are hidden from the row and offered under a "More" button, whole and in
 * order, so no tool is ever out of reach.
 */
export function DocumentToolStrip({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const items = flattenChildren(children);
  const strip = useRef<HTMLDivElement>(null);
  const [foldAt, setFoldAt] = useState<number | null>(null);

  useLayoutEffect(() => {
    const element = strip.current;
    if (!element) return;
    const measure = () => {
      const boxes = Array.from(element.querySelectorAll<HTMLElement>(':scope > [data-strip-item]'))
        .map((wrapper) => wrapper.firstElementChild as HTMLElement | null)
        .map((node) => (node ? node.offsetLeft + node.offsetWidth : 0));
      const width = element.clientWidth;
      const end = Math.max(0, ...boxes);
      if (!width || end <= width + 1) {
        setFoldAt(null);
        return;
      }
      const limit = width - MORE_BUTTON_WIDTH;
      const index = boxes.findIndex((right) => right > limit);
      setFoldAt(index < 0 ? null : index);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element
      .querySelectorAll<HTMLElement>(':scope > [data-strip-item] > *')
      .forEach((node) => observer.observe(node));
    return () => observer.disconnect();
  }, [items.length]);

  const folded = foldAt === null ? [] : items.slice(foldAt);

  return (
    <div
      ref={strip}
      role="toolbar"
      className={cn(
        'doc-toolstrip relative flex min-h-10 items-center overflow-hidden px-1.5 whitespace-nowrap',
        className,
      )}
    >
      {items.map((item, index) => {
        const hidden = foldAt !== null && index >= foldAt;
        return (
          <div
            key={index}
            data-strip-item=""
            className={cn('contents', hidden && 'invisible')}
            inert={hidden || undefined}
            aria-hidden={hidden || undefined}
          >
            {item}
          </div>
        );
      })}
      {folded.length ? (
        <div className="absolute inset-y-0 right-0 flex items-center bg-background pr-1.5 pl-2">
          <Popover>
            <PopoverTrigger asChild>
              <DocumentTopBarMenuButton aria-label="More tools">More</DocumentTopBarMenuButton>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="doc-toolstrip-more flex w-auto max-w-[min(32rem,90vw)] flex-col items-start gap-1 p-1.5"
            >
              {folded.map((item, index) => (
                <div key={index} className="flex flex-wrap items-center">
                  {item}
                </div>
              ))}
            </PopoverContent>
          </Popover>
        </div>
      ) : null}
    </div>
  );
}
