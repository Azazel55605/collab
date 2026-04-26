import { cn } from '../../lib/utils';

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest mb-3">
      {children}
    </p>
  );
}

export function OptionRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {description && <p className="text-[12px] text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function PillSelect<T extends string | number>({
  options,
  value,
  onChange,
  getLabel,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  getLabel?: (v: T) => string;
}) {
  return (
    <div className="flex gap-1 flex-wrap">
      {options.map((opt) => (
        <button
          key={opt}
          onClick={() => onChange(opt)}
          className={cn(
            'px-2.5 py-1 rounded-md text-[12px] font-medium border transition-all',
            value === opt
              ? 'bg-primary/15 border-primary/40 text-primary'
              : 'bg-transparent border-border/50 text-muted-foreground hover:text-foreground hover:border-border',
          )}
        >
          {getLabel ? getLabel(opt) : opt}
        </button>
      ))}
    </div>
  );
}

export function ToggleSwitch({
  checked,
  onToggle,
  disabled = false,
  animated = false,
}: {
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
  animated?: boolean;
}) {
  return (
    <button
      onClick={onToggle}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200',
        animated && 'app-motion-base',
        checked ? 'bg-primary' : 'bg-muted-foreground/30',
      )}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
    >
      <span
        className={cn(
          'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-200',
          animated && 'app-motion-base',
          checked ? 'translate-x-4' : 'translate-x-0',
        )}
      />
    </button>
  );
}
