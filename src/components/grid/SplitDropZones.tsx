import { useEffect, useRef, useState } from 'react';

import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from 'lucide-react';

import { type DragPoint, useDragContext } from '../../contexts/DragContext';
import { cn } from '../../lib/utils';
import { useEditorStore } from '../../store/editorStore';
import { useGridStore } from '../../store/gridStore';
import type { GridCellContent } from '../../store/gridStore';
import { useUiStore } from '../../store/uiStore';

type Direction = 'left' | 'right' | 'top' | 'bottom';

const ZONE_CONFIG: Record<
  Direction,
  {
    label: string;
    icon: React.ReactNode;
    style: React.CSSProperties;
    previewStyle: React.CSSProperties;
  }
> = {
  left: {
    label: 'Split left',
    icon: <ArrowLeft size={16} />,
    style: { left: 0, top: 0, width: '25%', height: '100%' },
    previewStyle: { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' },
  },
  right: {
    label: 'Split right',
    icon: <ArrowRight size={16} />,
    style: { right: 0, top: 0, width: '25%', height: '100%' },
    previewStyle: { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' },
  },
  top: {
    label: 'Split top',
    icon: <ArrowUp size={16} />,
    style: { left: '25%', top: 0, width: '50%', height: '25%' },
    previewStyle: { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' },
  },
  bottom: {
    label: 'Split bottom',
    icon: <ArrowDown size={16} />,
    style: { left: '25%', bottom: 0, width: '50%', height: '25%' },
    previewStyle: { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' },
  },
};

export default function SplitDropZones() {
  const { draggingTab, subscribePointer, registerDropResolver } = useDragContext();
  const [hoveredZone, setHoveredZone] = useState<Direction | null>(null);
  const { activateSplit } = useGridStore();
  const { activeTabPath, openTabs } = useEditorStore();
  const { activeView, setActiveView } = useUiStore();

  // Live element refs per zone, used to hit-test the pointer during a drag.
  const zoneRefs = useRef<Map<Direction, HTMLElement>>(new Map());

  /** Build content descriptor for "what's currently shown" */
  const getCurrentContent = (): GridCellContent => {
    const activeTab = openTabs.find((t) => t.relativePath === activeTabPath);
    if (activeTab) {
      return {
        type: activeTab.type as any,
        relativePath: activeTab.relativePath,
        title: activeTab.title,
      };
    }
    if (activeView === 'graph') return { type: 'graph', relativePath: null, title: 'Graph' };
    if (activeView === 'canvas') return { type: 'canvas', relativePath: null, title: 'Canvas' };
    if (activeView === 'kanban') return { type: 'kanban', relativePath: null, title: 'Kanban' };
    return { type: 'empty', relativePath: null, title: '' };
  };

  // Latest values captured for the stable pointer/drop callbacks below.
  const draggingTabRef = useRef(draggingTab);
  draggingTabRef.current = draggingTab;
  const performSplitRef = useRef<(direction: Direction) => void>(() => {});
  performSplitRef.current = (direction: Direction) => {
    const dragging = draggingTabRef.current;
    if (!dragging) return;
    const draggedContent: GridCellContent = {
      type: dragging.type as any,
      relativePath: dragging.relativePath,
      title: dragging.title,
    };
    activateSplit(draggedContent, getCurrentContent(), direction);
    setActiveView('grid');
  };

  const zoneAt = (point: DragPoint): Direction | null => {
    for (const [dir, el] of zoneRefs.current) {
      const rect = el.getBoundingClientRect();
      if (
        point.x >= rect.left &&
        point.x <= rect.right &&
        point.y >= rect.top &&
        point.y <= rect.bottom
      ) {
        return dir;
      }
    }
    return null;
  };

  // Highlight the zone under the pointer as the drag moves.
  useEffect(() => {
    return subscribePointer((point) => {
      setHoveredZone(point ? zoneAt(point) : null);
    });
  }, [subscribePointer]);

  // Activate the split when the drag ends over a zone.
  useEffect(() => {
    return registerDropResolver((point) => {
      const dir = zoneAt(point);
      if (!dir) return false;
      performSplitRef.current(dir);
      return true;
    });
  }, [registerDropResolver]);

  if (!draggingTab) return null;

  return (
    <div className="absolute inset-0 pointer-events-none z-50">
      {(Object.entries(ZONE_CONFIG) as [Direction, (typeof ZONE_CONFIG)[Direction]][]).map(
        ([dir, cfg]) => {
          const isHovered = hoveredZone === dir;
          return (
            <div
              key={dir}
              ref={(el) => {
                if (el) zoneRefs.current.set(dir, el);
                else zoneRefs.current.delete(dir);
              }}
              className={cn(
                'absolute transition-all duration-150 app-motion-base',
                isHovered ? 'bg-primary/25 backdrop-blur-2px-webkit' : 'bg-primary/8',
              )}
              style={cfg.style}
            >
              {/* Always-visible dashed border */}
              <div
                className={cn(
                  'absolute inset-0 border-2 border-dashed rounded transition-colors duration-150 app-motion-base',
                  isHovered ? 'border-primary/70' : 'border-primary/20',
                )}
              />

              {/* Label — always visible, stronger on hover */}
              <div className="absolute flex flex-col items-center gap-1.5" style={cfg.previewStyle}>
                <div
                  className={cn(
                    'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium shadow-lg transition-all duration-150 app-motion-base',
                    isHovered
                      ? 'bg-primary text-primary-foreground scale-105 shadow-primary/30 shadow-xl'
                      : 'bg-background/80 text-muted-foreground border border-border/50 scale-95 opacity-70',
                  )}
                >
                  {cfg.icon}
                  <span>{cfg.label}</span>
                </div>
              </div>
            </div>
          );
        },
      )}
    </div>
  );
}
