import { type ComponentProps, type PointerEvent, type ReactNode, useState } from 'react';

import {
  CircleAlert,
  ExternalLink,
  RotateCcw,
  Settings,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';

import { Button } from '../components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu';
import { Slider } from '../components/ui/slider';
import { cn } from '../lib/utils';

import { formatTime, speedLabel, SPEEDS } from './mediaFormat';

/** Circular arrow with "10" inside: skip back or forward ten seconds. */
export function SkipIcon({ direction, className }: { direction: -1 | 1; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      {direction < 0 ? (
        <>
          <path d="M3 12a9 9 0 1 0 2.64-6.36L3 8" />
          <path d="M3 3v5h5" />
        </>
      ) : (
        <>
          <path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" />
          <path d="M21 3v5h-5" />
        </>
      )}
      <text
        x={direction < 0 ? 12.5 : 11.5}
        y="15.5"
        textAnchor="middle"
        fontSize="7.5"
        fontWeight="700"
        fill="currentColor"
        stroke="none"
      >
        10
      </text>
    </svg>
  );
}

/**
 * Icon button for media controls. `overlay` styles it for the dark scrim drawn
 * over video; otherwise it follows the theme.
 */
export function MediaIconButton({
  overlay,
  pressed,
  className,
  ...props
}: ComponentProps<typeof Button> & { overlay?: boolean; pressed?: boolean }) {
  return (
    <Button
      variant="ghost"
      size="icon-lg"
      aria-pressed={pressed}
      className={cn(
        'relative [&_svg:not([class*=size-])]:size-5',
        overlay &&
          'text-white hover:bg-white/15 hover:text-white aria-expanded:bg-white/15 aria-expanded:text-white dark:hover:bg-white/15',
        overlay &&
          pressed &&
          'bg-primary/30 text-white hover:bg-primary/40 dark:hover:bg-primary/40',
        !overlay && pressed && 'bg-primary/15 text-primary hover:bg-primary/20',
        className,
      )}
      {...props}
    />
  );
}

export function Timeline({
  overlay,
  position,
  duration,
  buffered,
  disabled,
  onScrub,
  onCommit,
  onRelease,
  onCancel,
}: {
  overlay?: boolean;
  position: number;
  duration: number;
  /** End of the buffered range in seconds. */
  buffered: number;
  disabled: boolean;
  onScrub: (value: number) => void;
  onCommit: (value: number) => void;
  onRelease: () => void;
  onCancel: () => void;
}) {
  const [hover, setHover] = useState<{ time: number; x: number } | null>(null);
  const max = duration || 1;
  const bufferedPercent = Math.min(100, (buffered / max) * 100);

  const track = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled || !duration) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width) return;
    const fraction = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    setHover({ time: fraction * duration, x: fraction * 100 });
  };

  return (
    <div
      className="group/timeline relative"
      onPointerMove={track}
      onPointerLeave={() => setHover(null)}
    >
      <div
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute top-1/2 left-0 h-1 -translate-y-1/2 rounded-full transition-[height] group-hover/timeline:h-1.5',
          overlay ? 'bg-white/35' : 'bg-foreground/15',
        )}
        style={{ width: `${bufferedPercent}%` }}
      />
      {hover && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute bottom-full mb-1 -translate-x-1/2 rounded-md bg-popover px-1.5 py-px font-mono text-xs text-popover-foreground shadow-sm"
          style={{ left: `${hover.x}%` }}
        >
          {formatTime(hover.time)}
        </span>
      )}
      <Slider
        aria-label="Playback position"
        aria-valuetext={`${formatTime(position)} of ${formatTime(duration)}`}
        min={0}
        max={max}
        step={0.1}
        value={[position]}
        disabled={disabled}
        onValueChange={([value]) => onScrub(value)}
        onValueCommit={([value]) => onCommit(value)}
        onPointerUp={onRelease}
        onPointerCancel={onCancel}
        className="cursor-pointer"
        trackClassName={cn(
          'h-1 transition-[height] group-hover/timeline:h-1.5',
          overlay ? 'bg-white/20' : 'bg-foreground/10',
        )}
        thumbClassName={cn(
          'size-3.5 opacity-0 transition-opacity group-hover/timeline:opacity-100 focus-visible:opacity-100',
          overlay && 'border-white bg-white',
        )}
      />
    </div>
  );
}

export function VolumeControl({
  overlay,
  volume,
  muted,
  disabled,
  onToggleMute,
  onVolume,
}: {
  overlay?: boolean;
  volume: number;
  muted: boolean;
  disabled: boolean;
  onToggleMute: () => void;
  onVolume: (value: number) => void;
}) {
  const Icon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  return (
    <div className="flex items-center gap-1">
      <MediaIconButton
        overlay={overlay}
        aria-label={muted ? 'Unmute' : 'Mute'}
        disabled={disabled}
        onClick={onToggleMute}
      >
        <Icon />
      </MediaIconButton>
      <Slider
        className="w-20"
        aria-label="Volume"
        min={0}
        max={1}
        step={0.05}
        value={[muted ? 0 : volume]}
        disabled={disabled}
        onValueChange={([value]) => onVolume(value)}
        trackClassName={cn('h-1', overlay ? 'bg-white/25' : 'bg-foreground/10')}
        rangeClassName={overlay ? 'bg-white' : 'bg-foreground/70'}
        thumbClassName={cn('size-3', overlay && 'border-white bg-white')}
      />
    </div>
  );
}

export interface MediaSetting {
  id: string;
  label: string;
  value: string;
  choices: { label: string; value: string }[];
  onSelect: (value: string) => void;
}

/** One settings button whose rows drill into a radio list each. */
export function SettingsMenu({
  overlay,
  settings,
  onOpenChange,
  icon = <Settings />,
  label = 'Playback settings',
}: {
  overlay?: boolean;
  settings: MediaSetting[];
  onOpenChange: (open: boolean) => void;
  icon?: ReactNode;
  label?: string;
}) {
  if (!settings.length) return null;
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <MediaIconButton overlay={overlay} aria-label={label} title={label}>
          {icon}
        </MediaIconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" sideOffset={8} className="w-72 p-1.5">
        {settings.map((setting) => {
          const current = setting.choices.find((choice) => choice.value === setting.value);
          return (
            <DropdownMenuSub key={setting.id}>
              <DropdownMenuSubTrigger className="h-9 px-2.5">
                <span className="flex-1">{setting.label}</span>
                <span className="max-w-32 truncate text-xs text-muted-foreground">
                  {current?.label ?? setting.value}
                </span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-80 w-64 overflow-y-auto p-1.5">
                <DropdownMenuRadioGroup value={setting.value} onValueChange={setting.onSelect}>
                  {setting.choices.map((choice) => (
                    <DropdownMenuRadioItem
                      key={choice.value}
                      value={choice.value}
                      className="h-8"
                      title={choice.label}
                    >
                      <span className="truncate">{choice.label}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function MediaSpinner({ label, className }: { label?: string; className?: string }) {
  return (
    <span
      role="status"
      aria-label={label ?? 'Loading'}
      className={cn(
        'inline-block size-9 animate-spin rounded-full border-3 border-white/20 border-t-white motion-reduce:animate-none',
        className,
      )}
    />
  );
}

export function MediaErrorCard({
  message,
  onReload,
  onOpenExternally,
}: {
  message: string;
  onReload: () => void;
  onOpenExternally: () => void;
}) {
  return (
    <div
      role="alert"
      className="w-full max-w-sm rounded-xl border border-destructive/40 bg-popover p-4 text-popover-foreground shadow-lg"
    >
      <p className="flex items-center gap-2 font-semibold">
        <CircleAlert className="size-4 shrink-0 text-destructive" aria-hidden="true" />
        Can’t play this file
      </p>
      <p className="mt-1 text-sm break-words text-muted-foreground">{message}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={onReload}>
          <RotateCcw /> Reload
        </Button>
        <Button size="sm" onClick={onOpenExternally}>
          <ExternalLink /> Open externally
        </Button>
      </div>
    </div>
  );
}

const SHORTCUTS: { keys: string; action: string; video?: boolean }[] = [
  { keys: 'Space / K', action: 'Play or pause' },
  { keys: '← / →', action: 'Back / forward 5 s' },
  { keys: 'J / L', action: 'Back / forward 10 s' },
  { keys: '↑ / ↓', action: 'Volume' },
  { keys: 'M', action: 'Mute' },
  { keys: 'C', action: 'Subtitles on / off', video: true },
  { keys: 'F', action: 'Fullscreen', video: true },
  { keys: '0 – 9', action: 'Jump to 0 – 90 %' },
  { keys: '?', action: 'Show this list' },
];

export function ShortcutsCard({ video, onClose }: { video: boolean; onClose: () => void }) {
  return (
    <section
      aria-labelledby="media-shortcuts-heading"
      className="w-72 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-xl"
    >
      <div className="mb-2.5 flex items-center justify-between">
        <h2 id="media-shortcuts-heading" className="text-sm font-semibold">
          Keyboard shortcuts
        </h2>
        <Button variant="ghost" size="icon-sm" aria-label="Close shortcuts" onClick={onClose}>
          <X />
        </Button>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
        {SHORTCUTS.filter((shortcut) => video || !shortcut.video).map((shortcut) => (
          <div key={shortcut.keys} className="contents">
            <dt className="font-mono whitespace-nowrap">{shortcut.keys}</dt>
            <dd className="text-muted-foreground">{shortcut.action}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Compact speed chip for the audio player; video keeps speed in the settings menu. */
export function SpeedMenu({
  rate,
  disabled,
  onSelect,
  onOpenChange,
}: {
  rate: number;
  disabled: boolean;
  onSelect: (rate: number) => void;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-label={`Playback speed, ${speedLabel(rate)}`}
          className={cn(
            'rounded-full font-mono text-xs',
            rate !== 1 && 'border-primary/50 bg-primary/10 text-foreground',
          )}
        >
          {rate}×
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-36 p-1.5">
        <DropdownMenuRadioGroup
          value={String(rate)}
          onValueChange={(value) => onSelect(Number(value))}
        >
          {SPEEDS.map((speed) => (
            <DropdownMenuRadioItem key={speed} value={String(speed)} className="h-8">
              {speedLabel(speed)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
