import { Link2, Trash2 } from 'lucide-react';

import type { CanvasEdgeLineStyle } from '../../types/canvas';
import type { CanvasEdgeData } from './CanvasEdgeTypes';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

interface CanvasEdgeInspectorProps {
  selectedEdgeData: CanvasEdgeData | null;
  edgeLabelDraft: string;
  onEdgeLabelChange: (label: string) => void;
  onLineStyleChange: (lineStyle: CanvasEdgeLineStyle) => void;
  onAnimationDirectionChange: (animationReverse: boolean) => void;
  onAnimationChange: (animated: boolean) => void;
  onMarkerStartChange: (markerStart: boolean) => void;
  onMarkerEndChange: (markerEnd: boolean) => void;
  onDeleteSelected: () => void;
}

export function CanvasEdgeInspector({
  selectedEdgeData,
  edgeLabelDraft,
  onEdgeLabelChange,
  onLineStyleChange,
  onAnimationDirectionChange,
  onAnimationChange,
  onMarkerStartChange,
  onMarkerEndChange,
  onDeleteSelected,
}: CanvasEdgeInspectorProps) {
  return (
    <div className="pointer-events-auto flex max-w-[min(420px,calc(100vw-220px))] flex-col gap-2 rounded-2xl border border-border/60 bg-popover/90 p-2.5 shadow-xl backdrop-blur-xs-webkit app-fade-scale-in">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Link2 size={13} />
        Selected connection
      </div>
      {selectedEdgeData ? (
        <>
          <Input
            value={edgeLabelDraft}
            onChange={(event) => onEdgeLabelChange(event.target.value)}
            placeholder="Connection label"
            className="h-8"
          />
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl border border-border/60 bg-card/45 p-2">
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">Line type</div>
              <Select
                value={selectedEdgeData.lineStyle}
                onValueChange={(value) => onLineStyleChange(value as CanvasEdgeLineStyle)}
              >
                <SelectTrigger size="sm" className="h-8 w-full bg-background/70 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value="solid">Solid</SelectItem>
                  <SelectItem value="dashed">Dashed</SelectItem>
                  <SelectItem value="dotted">Dotted</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="rounded-xl border border-border/60 bg-card/45 p-2">
              <div className="mb-1 text-[11px] font-medium text-muted-foreground">Animation</div>
              <Select
                value={selectedEdgeData.animationReverse ? 'reverse' : 'forward'}
                onValueChange={(value) => onAnimationDirectionChange(value === 'reverse')}
                disabled={!selectedEdgeData.animated}
              >
                <SelectTrigger size="sm" className="h-8 w-full bg-background/70 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value="forward">Forward</SelectItem>
                  <SelectItem value="reverse">Reverse</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <label className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-card/45 px-3 py-2 text-xs">
            <span>
              <span className="block font-medium text-foreground">Animated line</span>
              <span className="block text-muted-foreground">Off by default, reversible when enabled.</span>
            </span>
            <Checkbox
              checked={selectedEdgeData.animated}
              onCheckedChange={(checked) => onAnimationChange(checked === true)}
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-card/45 px-3 py-2 text-xs">
              <span>
                <span className="block font-medium text-foreground">Start arrow</span>
                <span className="block text-muted-foreground">Show an arrowhead at the source.</span>
              </span>
              <Checkbox
                checked={selectedEdgeData.markerStart}
                onCheckedChange={(checked) => onMarkerStartChange(checked === true)}
              />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-xl border border-border/60 bg-card/45 px-3 py-2 text-xs">
              <span>
                <span className="block font-medium text-foreground">End arrow</span>
                <span className="block text-muted-foreground">Show an arrowhead at the target.</span>
              </span>
              <Checkbox
                checked={selectedEdgeData.markerEnd}
                onCheckedChange={(checked) => onMarkerEndChange(checked === true)}
              />
            </label>
          </div>
          <Button size="sm" variant="outline" className="gap-2 self-start" onClick={onDeleteSelected}>
            <Trash2 size={14} />
            Delete selected
          </Button>
        </>
      ) : (
        <div className="text-xs text-muted-foreground/75">
          Select a line to rename or delete it.
        </div>
      )}
    </div>
  );
}
