import { useEffect, useMemo, useRef, useState } from 'react';

import { Check, X } from 'lucide-react';

import { formatA1 } from '../../lib/sheet/address';
import { formulaAutocompleteContext, SHEET_FUNCTIONS } from '../../lib/sheet/formulaFunctions';
import { normalizeRange, selectedCellCount, type SheetSelection } from '../../lib/sheet/selection';
import type { SheetNamedRange } from '../../types/sheet';
import { Input } from '../ui/input';

import SheetFormulaIntellisense, { type SheetFormulaSuggestion } from './SheetFormulaIntellisense';

interface Props {
  selection: SheetSelection;
  /** Text of the active cell, or the in-progress edit when one is open. */
  value: string;
  editing: boolean;
  onChange: (text: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  cursor: number;
  onCursorChange: (cursor: number) => void;
  /** Jump to a typed cell, range, or visible named range. */
  onNavigate: (reference: string) => void;
  namedRanges?: readonly SheetNamedRange[];
  readOnly?: boolean;
}

/**
 * Name box plus formula bar. The name box shows the active cell, or the size of
 * a multi-cell selection the way a spreadsheet does (`3R x 2C`), and doubles as
 * a go-to-cell input.
 */
export function selectionLabel(selection: SheetSelection): string {
  const active = formatA1(selection.active);
  if (selection.ranges.length !== 1) return active;
  const rectangle = normalizeRange(selection.ranges[0]);
  const rowSpan = rectangle.bottom - rectangle.top + 1;
  const columnSpan = rectangle.right - rectangle.left + 1;
  if (rowSpan === 1 && columnSpan === 1) return active;
  return `${rowSpan}R x ${columnSpan}C`;
}

export default function SheetFormulaBar({
  selection,
  value,
  editing,
  onChange,
  onCommit,
  onCancel,
  cursor,
  onCursorChange,
  onNavigate,
  namedRanges = [],
  readOnly = false,
}: Props) {
  const [nameDraft, setNameDraft] = useState('');
  const [nameFocused, setNameFocused] = useState(false);
  const [formulaFocused, setFormulaFocused] = useState(false);
  const [suggestionsOpen, setSuggestionsOpen] = useState(true);
  const [selectedSuggestion, setSelectedSuggestion] = useState(0);
  const formulaInputRef = useRef<HTMLInputElement>(null);
  const pendingProgrammaticCursorRef = useRef<number | null>(null);
  const autocomplete = useMemo(() => formulaAutocompleteContext(value, cursor), [cursor, value]);
  const suggestions = useMemo(() => {
    if (!formulaFocused || !suggestionsOpen || !autocomplete) return [];
    const query = autocomplete.query.toLocaleUpperCase();
    const functions: SheetFormulaSuggestion[] = SHEET_FUNCTIONS.filter((definition) =>
      definition.name.startsWith(query),
    ).map((definition) => ({ ...definition, kind: 'function' }));
    const names: SheetFormulaSuggestion[] = namedRanges
      .filter((namedRange) => namedRange.name.toLocaleUpperCase().startsWith(query))
      .map((namedRange) => ({
        name: namedRange.name,
        signature: namedRange.scopeWorksheetId ? 'Worksheet named range' : 'Workbook named range',
        kind: 'named-range',
      }));
    return [...functions, ...names].slice(0, 8);
  }, [autocomplete, formulaFocused, namedRanges, suggestionsOpen]);

  useEffect(() => {
    if (!nameFocused) setNameDraft(selectionLabel(selection));
  }, [nameFocused, selection]);

  useEffect(() => {
    setSelectedSuggestion(0);
  }, [autocomplete?.query]);

  const placeCursor = (nextCursor: number) => {
    pendingProgrammaticCursorRef.current = nextCursor;
    onCursorChange(nextCursor);
    window.requestAnimationFrame(() => {
      formulaInputRef.current?.setSelectionRange(nextCursor, nextCursor);
      pendingProgrammaticCursorRef.current = null;
    });
  };

  const chooseSuggestion = (index: number) => {
    const definition = suggestions[index];
    if (!definition || !autocomplete) return;
    const suffix = definition.kind === 'function' ? '(' : '';
    const next = `${value.slice(0, autocomplete.start)}${definition.name}${suffix}${value.slice(autocomplete.end)}`;
    const nextCursor = autocomplete.start + definition.name.length + suffix.length;
    onChange(next);
    setSuggestionsOpen(false);
    placeCursor(nextCursor);
    formulaInputRef.current?.focus();
  };

  const submitName = () => {
    const reference = nameDraft.trim();
    if (reference) onNavigate(reference);
    setNameFocused(false);
  };

  return (
    <div className="relative flex shrink-0 items-center gap-2 border-b border-border/50 bg-background/60 px-2 py-1">
      <Input
        aria-label="Name box"
        value={nameDraft}
        onFocus={() => setNameFocused(true)}
        onChange={(event) => setNameDraft(event.target.value)}
        onBlur={submitName}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submitName();
            event.currentTarget.blur();
          }
          if (event.key === 'Escape') {
            setNameDraft(selectionLabel(selection));
            event.currentTarget.blur();
          }
        }}
        className="h-6 w-24 shrink-0 text-center text-[12px]"
      />

      <span className="shrink-0 text-[12px] text-muted-foreground select-none" aria-hidden>
        fx
      </span>

      <div className="relative min-w-0 flex-1">
        <Input
          ref={formulaInputRef}
          aria-label="Formula bar"
          value={value}
          readOnly={readOnly}
          onFocus={(event) => {
            setFormulaFocused(true);
            setSuggestionsOpen(true);
            onCursorChange(event.currentTarget.selectionStart ?? value.length);
          }}
          onBlur={() => window.setTimeout(() => setFormulaFocused(false), 100)}
          onClick={(event) => {
            pendingProgrammaticCursorRef.current = null;
            onCursorChange(event.currentTarget.selectionStart ?? value.length);
          }}
          onSelect={(event) => {
            const pendingCursor = pendingProgrammaticCursorRef.current;
            onCursorChange(pendingCursor ?? event.currentTarget.selectionStart ?? value.length);
          }}
          onChange={(event) => {
            pendingProgrammaticCursorRef.current = null;
            onChange(event.target.value);
            onCursorChange(event.currentTarget.selectionStart ?? event.target.value.length);
            setSuggestionsOpen(true);
          }}
          onKeyDown={(event) => {
            if (suggestions.length > 0 && event.key === 'ArrowDown') {
              event.preventDefault();
              setSelectedSuggestion((current) => (current + 1) % suggestions.length);
              return;
            }
            if (suggestions.length > 0 && event.key === 'ArrowUp') {
              event.preventDefault();
              setSelectedSuggestion(
                (current) => (current - 1 + suggestions.length) % suggestions.length,
              );
              return;
            }
            if (suggestions.length > 0 && (event.key === 'Tab' || event.key === 'Enter')) {
              event.preventDefault();
              chooseSuggestion(selectedSuggestion);
              return;
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              onCommit();
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              if (suggestionsOpen && suggestions.length > 0) {
                setSuggestionsOpen(false);
                return;
              }
              onCancel();
            }
          }}
          className="h-6 w-full font-mono text-[12.5px]"
        />
        {formulaFocused && value.startsWith('=') && (
          <SheetFormulaIntellisense
            value={value}
            cursor={cursor}
            suggestions={suggestions}
            selectedSuggestion={selectedSuggestion}
            onSelectSuggestion={setSelectedSuggestion}
            onChooseSuggestion={chooseSuggestion}
            className="absolute left-0 top-full z-40 mt-1 w-[min(28rem,100%)]"
          />
        )}
      </div>

      {editing && !readOnly && (
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label="Cancel edit"
            onClick={onCancel}
            className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          >
            <X size={13} />
          </button>
          <button
            type="button"
            aria-label="Commit edit"
            onClick={onCommit}
            className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          >
            <Check size={13} />
          </button>
        </div>
      )}

      <span className="shrink-0 text-[11px] text-muted-foreground select-none">
        {selectedCellCount(selection).toLocaleString()} selected
      </span>
    </div>
  );
}
