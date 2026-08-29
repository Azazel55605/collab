import { ArrowDown, ArrowUp, Trash2, X } from 'lucide-react';

import { setNodeFontSize, setNodeStyle, setNodeText } from '../../lib/svgDocument';
import { cn } from '../../lib/utils';
import type { SvgNode } from '../../types/svg';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { ColorPicker } from '../ui/color-picker';
import { Input } from '../ui/input';
import { Slider } from '../ui/slider';
import { Textarea } from '../ui/textarea';

interface Props {
  node: SvgNode;
  onChange: (updater: (node: SvgNode) => SvgNode) => void;
  onReorder: (direction: 'forward' | 'backward') => void;
  onDelete: () => void;
  onClose: () => void;
}

const NORMALIZE_COLOR = (value: string | null, fallback: string) => {
  if (!value || value === 'none') return fallback;
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

export function SvgPropertiesPanel({ node, onChange, onReorder, onDelete, onClose }: Props) {
  const supportsFill = node.type !== 'line';
  const fillOn = node.style.fill != null && node.style.fill !== 'none';
  const strokeOn = node.style.stroke != null && node.style.stroke !== 'none';

  return (
    <div className="absolute right-4 top-4 z-30 w-[min(260px,calc(100%-2rem))] rounded-xl border border-border/60 bg-popover/95 p-3 shadow-2xl shadow-black/25 backdrop-blur-sm-webkit app-panel-enter">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-sm font-medium capitalize">{node.type}</div>
        <Button size="icon" variant="ghost" className="size-7" onClick={onClose} title="Deselect">
          <X size={14} />
        </Button>
      </div>

      <div className="flex flex-col gap-2.5">
        {supportsFill && (
          <Row label="Fill">
            <Checkbox
              checked={fillOn}
              onCheckedChange={(checked) =>
                onChange((n) =>
                  setNodeStyle(n, {
                    fill: checked === true ? NORMALIZE_COLOR(n.style.fill, '#38bdf8') : 'none',
                  }),
                )
              }
              aria-label="Toggle fill"
            />
            <ColorPicker
              label="Fill colour"
              value={NORMALIZE_COLOR(node.style.fill, '#38bdf8')}
              disabled={!fillOn}
              onValueChange={(fill) => onChange((n) => setNodeStyle(n, { fill }))}
              className="w-32"
            />
          </Row>
        )}

        <Row label="Stroke">
          <Checkbox
            checked={strokeOn}
            onCheckedChange={(checked) =>
              onChange((n) =>
                setNodeStyle(n, {
                  stroke: checked === true ? NORMALIZE_COLOR(n.style.stroke, '#0f172a') : 'none',
                  strokeWidth:
                    checked === true && n.style.strokeWidth == null ? 2 : n.style.strokeWidth,
                }),
              )
            }
            aria-label="Toggle stroke"
          />
          <ColorPicker
            label="Stroke colour"
            value={NORMALIZE_COLOR(node.style.stroke, '#0f172a')}
            disabled={!strokeOn}
            onValueChange={(stroke) => onChange((n) => setNodeStyle(n, { stroke }))}
            className="w-32"
          />
        </Row>

        {strokeOn && (
          <Row label="Stroke width">
            <Input
              type="number"
              min={0}
              step={0.5}
              value={node.style.strokeWidth ?? 1}
              onChange={(e) =>
                onChange((n) =>
                  setNodeStyle(n, {
                    strokeWidth: Math.max(0, Number.parseFloat(e.target.value) || 0),
                  }),
                )
              }
              className="h-7 w-20 text-xs"
            />
          </Row>
        )}

        <Row label="Opacity">
          <Slider
            min={0}
            max={100}
            step={5}
            value={[(node.style.opacity ?? 1) * 100]}
            onValueChange={([opacity]) =>
              onChange((n) => setNodeStyle(n, { opacity: opacity / 100 }))
            }
            aria-label="Opacity"
            className="w-28"
          />
        </Row>

        {node.type === 'text' && (
          <>
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">Text</span>
              <Textarea
                value={node.text ?? ''}
                onChange={(e) => onChange((n) => setNodeText(n, e.target.value))}
                className="min-h-16 w-full text-sm"
                placeholder="Text"
              />
            </div>
            <Row label="Font size">
              <Input
                type="number"
                min={1}
                value={node.fontSize ?? 16}
                onChange={(e) =>
                  onChange((n) => setNodeFontSize(n, Number.parseFloat(e.target.value) || 1))
                }
                className="h-7 w-20 text-xs"
              />
            </Row>
          </>
        )}

        <div className="mt-1 flex items-center gap-1.5 border-t border-border/40 pt-2.5">
          <Button
            size="icon"
            variant="ghost"
            className={cn('size-8')}
            title="Bring forward"
            onClick={() => onReorder('forward')}
          >
            <ArrowUp size={14} />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            title="Send backward"
            onClick={() => onReorder('backward')}
          >
            <ArrowDown size={14} />
          </Button>
          <div className="flex-1" />
          <Button
            size="icon"
            variant="ghost"
            className="size-8 text-destructive hover:text-destructive"
            title="Delete element"
            onClick={onDelete}
          >
            <Trash2 size={14} />
          </Button>
        </div>
      </div>
    </div>
  );
}
