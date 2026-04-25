import { Crop, RotateCw } from 'lucide-react';

import { Button } from '../ui/button';
import { Input } from '../ui/input';

interface ImagePermanentToolbarProps {
  cropMode: boolean;
  resizeWidth: number | null;
  resizeHeight: number | null;
  widthPlaceholder: string;
  heightPlaceholder: string;
  lockAspectRatio: boolean;
  permanentDirty: boolean;
  onRotate: () => void;
  onBeginCrop: () => void;
  onResizeWidthChange: (value: string) => void;
  onResizeHeightChange: (value: string) => void;
  onToggleLockRatio: () => void;
  onReset: () => void;
  onSaveChanges: () => void;
}

export function ImagePermanentToolbar({
  cropMode,
  resizeWidth,
  resizeHeight,
  widthPlaceholder,
  heightPlaceholder,
  lockAspectRatio,
  permanentDirty,
  onRotate,
  onBeginCrop,
  onResizeWidthChange,
  onResizeHeightChange,
  onToggleLockRatio,
  onReset,
  onSaveChanges,
}: ImagePermanentToolbarProps) {
  return (
    <>
      <div className="mx-1 h-6 w-px bg-border/50" />
      <Button size="sm" variant="outline" className="h-8" onClick={onRotate}>
        <RotateCw size={14} className="mr-1.5" />
        Rotate
      </Button>
      <Button size="sm" variant={cropMode ? 'default' : 'outline'} className="h-8" onClick={onBeginCrop}>
        <Crop size={14} className="mr-1.5" />
        Crop
      </Button>
      <label className="flex items-center gap-2 rounded-lg border border-border/50 bg-background/40 px-2 py-1 text-[11px]">
        <span>W</span>
        <Input
          type="number"
          min={1}
          value={resizeWidth ?? ''}
          className="h-7 w-20"
          placeholder={widthPlaceholder}
          onChange={(event) => onResizeWidthChange(event.target.value)}
        />
      </label>
      <label className="flex items-center gap-2 rounded-lg border border-border/50 bg-background/40 px-2 py-1 text-[11px]">
        <span>H</span>
        <Input
          type="number"
          min={1}
          value={resizeHeight ?? ''}
          className="h-7 w-20"
          placeholder={heightPlaceholder}
          onChange={(event) => onResizeHeightChange(event.target.value)}
        />
      </label>
      <Button
        size="sm"
        variant={lockAspectRatio ? 'secondary' : 'outline'}
        className="h-8"
        onClick={onToggleLockRatio}
      >
        Lock Ratio
      </Button>
      <Button size="sm" variant="ghost" className="h-8" onClick={onReset}>
        Reset
      </Button>
      <Button size="sm" variant="secondary" className="h-8" disabled={!permanentDirty} onClick={onSaveChanges}>
        Save Changes
      </Button>
    </>
  );
}
