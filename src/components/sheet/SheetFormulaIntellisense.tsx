import { useMemo, type CSSProperties } from 'react';

import { cn } from '../../lib/utils';
import { activeFormulaFunction } from '../../lib/sheet/formulaFunctions';
import { parseFormulaReferences } from '../../lib/sheet/formulaReferences';

export interface SheetFormulaSuggestion {
  name: string;
  signature: string;
  kind: 'function' | 'named-range';
}

interface Props {
  value: string;
  cursor: number;
  suggestions: readonly SheetFormulaSuggestion[];
  selectedSuggestion: number;
  onSelectSuggestion: (index: number) => void;
  onChooseSuggestion: (index: number) => void;
  className?: string;
  style?: CSSProperties;
  label?: string;
}

export default function SheetFormulaIntellisense({
  value,
  cursor,
  suggestions,
  selectedSuggestion,
  onSelectSuggestion,
  onChooseSuggestion,
  className,
  style,
  label = 'Formula IntelliSense',
}: Props) {
  const activeFunction = useMemo(
    () => activeFormulaFunction(value, cursor),
    [cursor, value],
  );
  const highlighted = useMemo(() => {
    if (!value.startsWith('=')) return null;
    const references = parseFormulaReferences(value);
    const parts: Array<{ text: string; kind: 'plain' | 'reference' }> = [];
    let offset = 0;
    for (const reference of references) {
      if (reference.start > offset) {
        parts.push({ text: value.slice(offset, reference.start), kind: 'plain' });
      }
      parts.push({ text: reference.source, kind: 'reference' });
      offset = reference.end;
    }
    if (offset < value.length) {
      parts.push({ text: value.slice(offset), kind: 'plain' });
    }
    return parts;
  }, [value]);

  if (!value.startsWith('=')) return null;

  return (
    <div
      className={cn(
        'overflow-hidden rounded-md border border-border bg-popover shadow-lg',
        className,
      )}
      style={style}
      aria-label={label}
    >
      {suggestions.length > 0 && (
        <div
          role="listbox"
          aria-label="Formula suggestions"
          className="max-h-52 overflow-y-auto py-1"
        >
          {suggestions.map((definition, index) => (
            <button
              key={`${definition.kind}:${definition.name}`}
              type="button"
              role="option"
              aria-selected={index === selectedSuggestion}
              className={cn(
                'flex w-full items-center justify-between gap-3 px-2.5 py-1.5 text-left',
                index === selectedSuggestion ? 'bg-accent' : 'hover:bg-accent/60',
              )}
              onMouseEnter={() => onSelectSuggestion(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                onChooseSuggestion(index);
              }}
            >
              <span className="font-mono text-[12px] text-violet-300">
                {definition.name}
              </span>
              <span className="truncate text-[10.5px] text-muted-foreground">
                {definition.signature}
              </span>
            </button>
          ))}
        </div>
      )}
      {suggestions.length === 0 && activeFunction && (
        <div className="border-b border-border/60 px-2.5 py-2">
          <div className="font-mono text-[11.5px] text-violet-300">
            {activeFunction.signature}
          </div>
          {activeFunction.note && (
            <div className="mt-1 text-[10.5px] text-muted-foreground">
              {activeFunction.note}
            </div>
          )}
        </div>
      )}
      {highlighted && (
        <div
          className="truncate border-t border-border/60 px-2.5 py-1.5 font-mono text-[10.5px]"
          aria-label="Formula syntax"
        >
          {highlighted.map((part, index) => (
            <span
              key={`${part.text}-${index}`}
              className={part.kind === 'reference'
                ? 'text-cyan-400'
                : 'text-popover-foreground'}
            >
              {part.text}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
