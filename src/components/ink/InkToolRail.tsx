import { type ReactNode, useState } from 'react';

import {
  Brush,
  Check,
  CircleDot,
  Eraser,
  Gauge,
  Hand,
  Highlighter,
  Image,
  Lasso,
  Minus,
  MousePointer2,
  MoveHorizontal,
  Pencil,
  PenLine,
  PenTool,
  Pipette,
  Ruler,
  Search,
  Shapes,
  Sigma,
  Stamp,
  StickyNote,
  Type,
  Workflow,
} from 'lucide-react';

import { INK_DEFAULT_BRUSHES } from '../../lib/ink/document';
import { INK_BRUSH_ORDER, INK_SHORTCUTS } from '../../lib/ink/tools';
import type { InkToolId, InkToolState } from '../../lib/ink/tools';
import { cn } from '../../lib/utils';
import type { InkBrushKind } from '../../types/ink';
import { FloatingBar, FloatingSeparator, RailButton } from '../layout/CanvasChrome';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';

/**
 * The tool rail: a floating, icon-only bar on the left of the page.
 *
 * Related tools share one button (selection, shapes, text, inserts, measuring,
 * inspecting). The button shows the tool last used from its group, a click
 * picks that tool again, and the small corner arrow opens the rest of the group.
 * Labels live in tooltips and menus, each with its keyboard shortcut, so the
 * rail teaches the shortcuts rather than competing with them.
 */

const BRUSH_ICONS: Record<InkBrushKind, ReactNode> = {
  ballpoint: <PenLine />,
  fountain: <PenTool />,
  technical: <Minus />,
  pencil: <Pencil />,
  marker: <Brush />,
  brush: <Brush />,
  highlighter: <Highlighter />,
};

function shortcutKey(command: string): string {
  const shortcut = INK_SHORTCUTS.find((entry) => entry.command === command);
  if (!shortcut) return '';
  return [
    shortcut.ctrl ? 'Ctrl' : '',
    shortcut.shift ? 'Shift' : '',
    shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key,
  ]
    .filter(Boolean)
    .join('+');
}

interface ToolEntry {
  id: InkToolId;
  name: string;
  icon: ReactNode;
  /** Changes the drawing, so it is unavailable when read-only. */
  edits: boolean;
}

function tool(id: InkToolId, name: string, icon: ReactNode, edits = true): ToolEntry {
  return { id, name, icon, edits };
}

function toolLabel(entry: ToolEntry): string {
  const key = shortcutKey(`tool.${entry.id}`);
  return key ? `${entry.name} (${key})` : entry.name;
}

const TOOL_GROUPS: { id: string; name: string; tools: ToolEntry[] }[] = [
  {
    id: 'select',
    name: 'Selection',
    tools: [
      tool('select', 'Select', <MousePointer2 />, false),
      tool('lasso', 'Lasso', <Lasso />, false),
    ],
  },
  {
    id: 'shape',
    name: 'Shape',
    tools: [tool('shape', 'Shape', <Shapes />), tool('connector', 'Connector', <Workflow />)],
  },
  {
    id: 'text',
    name: 'Text',
    tools: [
      tool('text', 'Text', <Type />),
      tool('sticky', 'Sticky note', <StickyNote />),
      tool('equation', 'Equation', <Sigma />),
    ],
  },
  {
    id: 'insert',
    name: 'Insert',
    tools: [tool('image', 'Image', <Image />), tool('stamp', 'Stamp', <Stamp />)],
  },
  {
    id: 'measure',
    name: 'Measure',
    tools: [
      tool('ruler', 'Ruler', <Ruler />),
      tool('protractor', 'Protractor', <Gauge />),
      tool('compass', 'Compass', <CircleDot />),
      tool('guide', 'Guide', <MoveHorizontal />),
    ],
  },
  {
    id: 'inspect',
    name: 'Inspect',
    tools: [
      tool('loupe', 'Loupe', <Search />, false),
      tool('eyedropper', 'Eyedropper', <Pipette />, false),
    ],
  },
];

/** Corner arrow that opens a group's menu; sits over the button's bottom-right. */
function GroupMenuTrigger({ label, disabled }: { label: string; disabled?: boolean }) {
  return (
    <DropdownMenuTrigger asChild disabled={disabled}>
      <button
        type="button"
        aria-label={label}
        title={label}
        className="absolute right-0 bottom-0 flex size-3.5 items-end justify-end rounded-br-md p-px text-muted-foreground hover:text-foreground disabled:opacity-40"
      >
        <svg viewBox="0 0 6 6" className="size-1.5 fill-current" aria-hidden="true">
          <path d="M6 0V6H0Z" />
        </svg>
      </button>
    </DropdownMenuTrigger>
  );
}

function MenuEntry({
  label,
  shortcut,
  icon,
  active,
  disabled,
  onSelect,
}: {
  label: string;
  shortcut?: string;
  icon: ReactNode;
  active: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem
      aria-label={shortcut ? `${label} (${shortcut})` : label}
      disabled={disabled}
      onSelect={onSelect}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {shortcut && <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>}
      <Check className={cn('size-3.5', !active && 'invisible')} />
    </DropdownMenuItem>
  );
}

/** Picking a tool should leave focus with the page, not hand it back to the rail. */
function keepFocusOnPage(event: Event) {
  event.preventDefault();
}

export interface InkToolRailProps {
  tool: InkToolState;
  readOnly: boolean;
  onSelectTool: (tool: InkToolId) => void;
  onSelectBrush: (kind: InkBrushKind) => void;
  className?: string;
}

export default function InkToolRail({
  tool: current,
  readOnly,
  onSelectTool,
  onSelectBrush,
  className,
}: InkToolRailProps) {
  const [lastUsed, setLastUsed] = useState<Record<string, InkToolId>>({});

  const pick = (groupId: string, id: InkToolId) => {
    setLastUsed((previous) => ({ ...previous, [groupId]: id }));
    onSelectTool(id);
  };

  const groupButton = (group: (typeof TOOL_GROUPS)[number]) => {
    const active = group.tools.find((entry) => entry.id === current.tool);
    const shown =
      active ??
      group.tools.find((entry) => entry.id === lastUsed[group.id]) ??
      group.tools.find((entry) => !readOnly || !entry.edits) ??
      group.tools[0];
    const allDisabled = readOnly && group.tools.every((entry) => entry.edits);
    return (
      <div key={group.id} className="relative">
        <RailButton
          label={toolLabel(shown)}
          pressed={Boolean(active)}
          disabled={readOnly && shown.edits}
          onClick={() => pick(group.id, shown.id)}
        >
          {shown.icon}
        </RailButton>
        <DropdownMenu modal={false}>
          <GroupMenuTrigger label={`${group.name} tools`} disabled={allDisabled} />
          <DropdownMenuContent
            side="right"
            align="start"
            sideOffset={8}
            className="w-52"
            onCloseAutoFocus={keepFocusOnPage}
          >
            <DropdownMenuLabel className="text-[11px]">{group.name}</DropdownMenuLabel>
            {group.tools.map((entry) => (
              <MenuEntry
                key={entry.id}
                label={entry.name}
                shortcut={shortcutKey(`tool.${entry.id}`)}
                icon={entry.icon}
                active={entry.id === current.tool}
                disabled={readOnly && entry.edits}
                onSelect={() => pick(group.id, entry.id)}
              />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  };

  return (
    <FloatingBar
      orientation="vertical"
      role="toolbar"
      aria-label="Drawing tools"
      className={cn('top-1/2 left-3 -translate-y-1/2', className)}
    >
      <div className="relative">
        <RailButton
          label={`Pen (${shortcutKey('tool.pen')})`}
          pressed={current.tool === 'pen'}
          disabled={readOnly}
          onClick={() => onSelectTool('pen')}
        >
          {BRUSH_ICONS[current.brush.kind] ?? <PenLine />}
        </RailButton>
        <DropdownMenu modal={false}>
          <GroupMenuTrigger label="Brushes" disabled={readOnly} />
          <DropdownMenuContent
            side="right"
            align="start"
            sideOffset={8}
            className="w-52"
            onCloseAutoFocus={keepFocusOnPage}
          >
            <DropdownMenuLabel className="text-[11px]">Brushes</DropdownMenuLabel>
            {INK_BRUSH_ORDER.map((kind) => (
              <MenuEntry
                key={kind}
                label={INK_DEFAULT_BRUSHES[kind]?.name ?? kind}
                icon={BRUSH_ICONS[kind]}
                active={current.tool === 'pen' && current.brush.kind === kind}
                onSelect={() => onSelectBrush(kind)}
              />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <RailButton
        label={`Eraser (${shortcutKey('tool.eraser')})`}
        pressed={current.tool === 'eraser'}
        disabled={readOnly}
        onClick={() => onSelectTool('eraser')}
      >
        <Eraser />
      </RailButton>
      <FloatingSeparator vertical />
      {TOOL_GROUPS.map(groupButton)}
      <FloatingSeparator vertical />
      <RailButton
        label={`Pan (${shortcutKey('tool.pan')})`}
        pressed={current.tool === 'pan'}
        onClick={() => onSelectTool('pan')}
      >
        <Hand />
      </RailButton>
    </FloatingBar>
  );
}
