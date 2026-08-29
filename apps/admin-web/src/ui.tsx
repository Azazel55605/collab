import { forwardRef, useEffect, useRef, useState } from 'react';

import { Check, ChevronDown } from 'lucide-react';

function cn(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(' ');
}

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'outline' | 'ghost' | 'destructive';
  size?: 'default' | 'sm' | 'icon';
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'default', ...props }, ref) => (
    <button
      ref={ref}
      className={cn('ui-button', `ui-button-${variant}`, `ui-button-${size}`, className)}
      {...props}
    />
  ),
);
Button.displayName = 'Button';

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} className={cn('ui-input', className)} {...props} />
  ),
);
Input.displayName = 'Input';

export const Checkbox = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} type="checkbox" className={cn('ui-checkbox', className)} {...props} />
  ),
);
Checkbox.displayName = 'Checkbox';

export function Card({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return <section className={cn('ui-card', className)} {...props} />;
}

export function Badge({
  className,
  variant = 'secondary',
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & {
  variant?: 'secondary' | 'success' | 'destructive' | 'outline';
}) {
  return <span className={cn('ui-badge', `ui-badge-${variant}`, className)} {...props} />;
}

export function Separator({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn('ui-separator', className)} />;
}

export interface SelectMenuOption {
  value: string;
  label: string;
}

export function SelectMenu({
  value,
  options,
  onChange,
  label,
  disabled,
  size = 'default',
}: {
  value: string;
  options: SelectMenuOption[];
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
  size?: 'default' | 'sm';
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);
  const selected = options.find((option) => option.value === value);
  return (
    <div ref={containerRef} className="ui-select-menu">
      <button
        type="button"
        className={cn('ui-select-trigger', size === 'sm' && 'sm')}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span>{selected?.label ?? value}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div className="ui-select-list" role="listbox" aria-label={label}>
          {options.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              key={option.value}
              className="ui-select-option"
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              {option.label}
              {option.value === value && <Check size={13} aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function DialogShell({
  title,
  description,
  onClose,
  children,
  className,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);
  return (
    <div className="ui-dialog-overlay" role="presentation" onClick={onClose}>
      <Card
        className={cn('ui-dialog', className)}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <h2>{title}</h2>
        {description && <p>{description}</p>}
        {children}
      </Card>
    </div>
  );
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel = 'Confirm',
  destructive,
  onCancel,
  onConfirm,
}: {
  title: string;
  description?: string;
  confirmLabel?: string;
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <DialogShell title={title} description={description} onClose={onCancel}>
      <div className="ui-dialog-actions">
        <Button variant="outline" autoFocus onClick={onCancel}>
          Cancel
        </Button>
        <Button variant={destructive ? 'destructive' : 'default'} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </DialogShell>
  );
}

export function PromptDialog({
  title,
  description,
  label,
  defaultValue = '',
  type = 'text',
  minLength,
  submitLabel = 'Save',
  onCancel,
  onSubmit,
}: {
  title: string;
  description?: string;
  label: string;
  defaultValue?: string;
  type?: 'text' | 'password';
  minLength?: number;
  submitLabel?: string;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}) {
  return (
    <DialogShell title={title} description={description} onClose={onCancel}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const raw = String(new FormData(event.currentTarget).get('value') ?? '');
          const value = type === 'password' ? raw : raw.trim();
          if (value) onSubmit(value);
        }}
      >
        <label className="field">
          <span>{label}</span>
          <Input
            name="value"
            type={type}
            defaultValue={defaultValue}
            minLength={minLength}
            autoFocus
            required
          />
        </label>
        <div className="ui-dialog-actions">
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button>{submitLabel}</Button>
        </div>
      </form>
    </DialogShell>
  );
}

export function Switch({
  checked,
  onCheckedChange,
  label,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className="ui-switch"
      onClick={() => onCheckedChange(!checked)}
    >
      <span />
    </button>
  );
}
