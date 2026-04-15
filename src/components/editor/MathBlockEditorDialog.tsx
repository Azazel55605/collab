import { useEffect, useMemo, useRef, useState } from 'react';
import katex from 'katex';
import {
  Braces,
  Calculator,
  FunctionSquare,
  Grid2x2,
  Minus,
  Plus,
  Sigma,
  SquareRadical,
  Superscript,
} from 'lucide-react';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Separator } from '../ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { Textarea } from '../ui/textarea';

type MathEditorMode = 'insert' | 'edit';
type MatrixEnvironment = 'bmatrix' | 'pmatrix' | 'vmatrix' | 'Bmatrix';
type OperatorKind = 'sum' | 'prod';
type BracketSide = '(' | '[' | '\\{' | '|' | '\\langle';
type RightBracketSide = ')' | ']' | '\\}' | '|' | '\\rangle';

interface ScriptDraft {
  base: string;
  superscript: string;
  subscript: string;
}

interface FractionDraft {
  numerator: string;
  denominator: string;
}

interface RootDraft {
  degree: string;
  radicand: string;
}

interface OperatorDraft {
  kind: OperatorKind;
  index: string;
  lower: string;
  upper: string;
  body: string;
}

interface BracketDraft {
  left: BracketSide;
  right: RightBracketSide;
  content: string;
}

interface MatrixDraft {
  environment: MatrixEnvironment;
  rows: string[][];
}

interface ParsedMathDrafts {
  script: ScriptDraft;
  fraction: FractionDraft;
  root: RootDraft;
  operator: OperatorDraft;
  bracket: BracketDraft;
  matrix: MatrixDraft;
}

interface MathBlockEditorDialogProps {
  open: boolean;
  mode: MathEditorMode;
  initialSource: string;
  onOpenChange: (open: boolean) => void;
  onApply: (source: string) => void;
}

type SnippetButton = {
  label: string;
  snippet: string;
};

const GREEK_SYMBOLS: SnippetButton[] = [
  { label: 'alpha', snippet: '\\alpha ' },
  { label: 'beta', snippet: '\\beta ' },
  { label: 'gamma', snippet: '\\gamma ' },
  { label: 'delta', snippet: '\\delta ' },
  { label: 'theta', snippet: '\\theta ' },
  { label: 'lambda', snippet: '\\lambda ' },
  { label: 'mu', snippet: '\\mu ' },
  { label: 'pi', snippet: '\\pi ' },
  { label: 'sigma', snippet: '\\sigma ' },
  { label: 'phi', snippet: '\\phi ' },
  { label: 'omega', snippet: '\\omega ' },
  { label: 'Delta', snippet: '\\Delta ' },
  { label: 'Gamma', snippet: '\\Gamma ' },
  { label: 'Pi', snippet: '\\Pi ' },
  { label: 'Sigma', snippet: '\\Sigma ' },
  { label: 'Omega', snippet: '\\Omega ' },
];

const RELATION_SYMBOLS: SnippetButton[] = [
  { label: '=', snippet: '= ' },
  { label: 'neq', snippet: '\\neq ' },
  { label: 'approx', snippet: '\\approx ' },
  { label: 'leq', snippet: '\\leq ' },
  { label: 'geq', snippet: '\\geq ' },
  { label: 'in', snippet: '\\in ' },
  { label: 'subset', snippet: '\\subset ' },
  { label: 'subseteq', snippet: '\\subseteq ' },
  { label: 'to', snippet: '\\to ' },
  { label: 'Rightarrow', snippet: '\\Rightarrow ' },
];

const OPERATOR_SYMBOLS: SnippetButton[] = [
  { label: '+', snippet: '+ ' },
  { label: '-', snippet: '- ' },
  { label: 'times', snippet: '\\times ' },
  { label: 'cdot', snippet: '\\cdot ' },
  { label: 'div', snippet: '\\div ' },
  { label: 'pm', snippet: '\\pm ' },
  { label: 'sqrt', snippet: '\\sqrt{<selection>}<cursor>' },
  { label: 'frac', snippet: '\\frac{<selection>}{<cursor>}' },
  { label: 'int', snippet: '\\int ' },
  { label: 'partial', snippet: '\\partial ' },
];

const FUNCTION_SYMBOLS: SnippetButton[] = [
  { label: 'sin', snippet: '\\sin\\left(<selection>\\right)<cursor>' },
  { label: 'cos', snippet: '\\cos\\left(<selection>\\right)<cursor>' },
  { label: 'tan', snippet: '\\tan\\left(<selection>\\right)<cursor>' },
  { label: 'log', snippet: '\\log\\left(<selection>\\right)<cursor>' },
  { label: 'ln', snippet: '\\ln\\left(<selection>\\right)<cursor>' },
  { label: 'lim', snippet: '\\lim_{<cursor>} ' },
  { label: 'vec', snippet: '\\vec{<selection>}<cursor>' },
  { label: 'hat', snippet: '\\hat{<selection>}<cursor>' },
];

function createEmptyDrafts(): ParsedMathDrafts {
  return {
    script: {
      base: 'x',
      superscript: '',
      subscript: '',
    },
    fraction: {
      numerator: '',
      denominator: '',
    },
    root: {
      degree: '',
      radicand: '',
    },
    operator: {
      kind: 'sum',
      index: 'i',
      lower: '1',
      upper: 'n',
      body: 'a_i',
    },
    bracket: {
      left: '(',
      right: ')',
      content: '',
    },
    matrix: {
      environment: 'bmatrix',
      rows: createMatrixGrid(2, 2),
    },
  };
}

function createMatrixGrid(rowCount: number, colCount: number) {
  return Array.from({ length: rowCount }, () => Array.from({ length: colCount }, () => ''));
}

function readBalancedGroup(source: string, start: number, openChar: string, closeChar: string) {
  if (source[start] !== openChar) return null;
  let depth = 0;
  let value = '';
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === openChar) {
      depth += 1;
      if (depth > 1) value += char;
      continue;
    }
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return {
          value,
          end: index + 1,
        };
      }
      value += char;
      continue;
    }
    value += char;
  }
  return null;
}

function parseExactFraction(source: string) {
  const trimmed = source.trim();
  if (!trimmed.startsWith('\\frac')) return null;
  let index = '\\frac'.length;
  const numerator = readBalancedGroup(trimmed, index, '{', '}');
  if (!numerator) return null;
  index = numerator.end;
  const denominator = readBalancedGroup(trimmed, index, '{', '}');
  if (!denominator || denominator.end !== trimmed.length) return null;
  return {
    numerator: numerator.value.trim(),
    denominator: denominator.value.trim(),
  };
}

function parseExactRoot(source: string) {
  const trimmed = source.trim();
  if (!trimmed.startsWith('\\sqrt')) return null;
  let index = '\\sqrt'.length;
  let degree = '';
  if (trimmed[index] === '[') {
    const optionalDegree = readBalancedGroup(trimmed, index, '[', ']');
    if (!optionalDegree) return null;
    degree = optionalDegree.value.trim();
    index = optionalDegree.end;
  }
  const radicand = readBalancedGroup(trimmed, index, '{', '}');
  if (!radicand || radicand.end !== trimmed.length) return null;
  return {
    degree,
    radicand: radicand.value.trim(),
  };
}

function parseExactScripts(source: string) {
  const trimmed = source.trim();
  if (!trimmed) return null;

  let base = '';
  let cursor = 0;
  if (trimmed[cursor] === '{') {
    const baseGroup = readBalancedGroup(trimmed, cursor, '{', '}');
    if (!baseGroup) return null;
    base = baseGroup.value.trim();
    cursor = baseGroup.end;
  } else {
    while (cursor < trimmed.length && trimmed[cursor] !== '^' && trimmed[cursor] !== '_') {
      base += trimmed[cursor];
      cursor += 1;
    }
    base = base.trim();
  }

  if (!base || cursor >= trimmed.length) return null;

  let superscript = '';
  let subscript = '';
  while (cursor < trimmed.length) {
    const operator = trimmed[cursor];
    if (operator !== '^' && operator !== '_') return null;
    cursor += 1;
    let tokenValue = '';
    if (trimmed[cursor] === '{') {
      const group = readBalancedGroup(trimmed, cursor, '{', '}');
      if (!group) return null;
      tokenValue = group.value.trim();
      cursor = group.end;
    } else {
      tokenValue = (trimmed[cursor] ?? '').trim();
      cursor += 1;
    }
    if (!tokenValue) return null;
    if (operator === '^') superscript = tokenValue;
    if (operator === '_') subscript = tokenValue;
  }

  if (!superscript && !subscript) return null;
  return { base, superscript, subscript };
}

function parseExactOperator(source: string) {
  const match = source.trim().match(/^\\(sum|prod)_\{([^}]*)\}\^\{([^}]*)\}\s+(.+)$/s);
  if (!match) return null;
  const body = match[4].trim();
  const indexParts = match[2].split('=');
  return {
    kind: match[1] as OperatorKind,
    index: indexParts[0]?.trim() || 'i',
    lower: indexParts.slice(1).join('=').trim() || match[2].trim(),
    upper: match[3].trim(),
    body,
  };
}

function parseExactBracketed(source: string) {
  const match = source.trim().match(/^\\left(\(|\[|\\\{|\\langle|\|)(.+)\\right(\)|\]|\\\}|\\rangle|\|)$/s);
  if (!match) return null;
  const left = match[1] as BracketSide;
  return {
    left,
    right: match[3] as RightBracketSide,
    content: match[2].trim(),
  };
}

function parseExactMatrix(source: string) {
  const match = source.trim().match(/^\\begin\{(bmatrix|pmatrix|vmatrix|Bmatrix)\}([\s\S]*)\\end\{\1\}$/);
  if (!match) return null;
  const rows = match[2]
    .split(/\\\\/)
    .map((row) => row.trim())
    .filter((row) => row.length > 0)
    .map((row) => row.split('&').map((cell) => cell.trim()));
  if (!rows.length) return null;
  const colCount = rows[0].length;
  if (!rows.every((row) => row.length === colCount)) return null;
  return {
    environment: match[1] as MatrixEnvironment,
    rows,
  };
}

function parseSourceIntoDrafts(source: string) {
  const base = createEmptyDrafts();
  const trimmed = source.trim();
  if (!trimmed) return base;

  const fraction = parseExactFraction(trimmed);
  if (fraction) base.fraction = fraction;

  const root = parseExactRoot(trimmed);
  if (root) base.root = root;

  const scripts = parseExactScripts(trimmed);
  if (scripts) base.script = scripts;

  const operator = parseExactOperator(trimmed);
  if (operator) base.operator = operator;

  const bracket = parseExactBracketed(trimmed);
  if (bracket) base.bracket = bracket;

  const matrix = parseExactMatrix(trimmed);
  if (matrix) base.matrix = matrix;

  return base;
}

function wrapIfNeeded(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^[A-Za-z0-9]$/.test(trimmed)) return trimmed;
  if (/^\\[A-Za-z]+$/.test(trimmed)) return trimmed;
  if (/^\{.*\}$/.test(trimmed)) return trimmed;
  return `{${trimmed}}`;
}

function buildScriptSnippet(draft: ScriptDraft) {
  const base = draft.base.trim();
  if (!base) return '';
  const basePart = wrapIfNeeded(base);
  const lower = draft.subscript.trim();
  const upper = draft.superscript.trim();
  let result = basePart;
  if (lower) result += `_${wrapIfNeeded(lower)}`;
  if (upper) result += `^${wrapIfNeeded(upper)}`;
  return result;
}

function buildFractionSnippet(draft: FractionDraft) {
  const numerator = draft.numerator.trim() || 'a';
  const denominator = draft.denominator.trim() || 'b';
  return `\\frac{${numerator}}{${denominator}}`;
}

function buildRootSnippet(draft: RootDraft) {
  const radicand = draft.radicand.trim() || 'x';
  if (draft.degree.trim()) {
    return `\\sqrt[${draft.degree.trim()}]{${radicand}}`;
  }
  return `\\sqrt{${radicand}}`;
}

function buildOperatorSnippet(draft: OperatorDraft) {
  const lower = `${draft.index.trim() || 'i'}=${draft.lower.trim() || '1'}`;
  const upper = draft.upper.trim() || 'n';
  const body = draft.body.trim() || 'a_i';
  return `\\${draft.kind}_{${lower}}^{${upper}} ${body}`;
}

function buildBracketSnippet(draft: BracketDraft) {
  const content = draft.content.trim() || 'x';
  const rightMap: Record<BracketSide, string> = {
    '(': ')',
    '[': ']',
    '\\{': '\\}',
    '|': '|',
    '\\langle': '\\rangle',
  };
  return `\\left${draft.left}${content}\\right${draft.right || rightMap[draft.left]}`;
}

function buildMatrixSnippet(draft: MatrixDraft) {
  const body = draft.rows
    .map((row) => row.map((cell) => cell.trim() || '0').join(' & '))
    .join(' \\\\ ');
  return `\\begin{${draft.environment}} ${body} \\end{${draft.environment}}`;
}

function SymbolGrid({
  title,
  items,
  onInsert,
}: {
  title: string;
  items: SnippetButton[];
  onInsert: (snippet: string) => void;
}) {
  return (
    <section className="space-y-2">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {items.map((item) => (
          <Button
            key={`${title}-${item.label}`}
            type="button"
            variant="outline"
            size="sm"
            className="justify-start truncate"
            onClick={() => onInsert(item.snippet)}
          >
            {item.label}
          </Button>
        ))}
      </div>
    </section>
  );
}

export function MathBlockEditorDialog({
  open,
  mode,
  initialSource,
  onOpenChange,
  onApply,
}: MathBlockEditorDialogProps) {
  const [source, setSource] = useState(initialSource);
  const [drafts, setDrafts] = useState<ParsedMathDrafts>(() => parseSourceIntoDrafts(initialSource));
  const sourceRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingSelectionRef = useRef<{ start: number; end: number } | null>(null);

  useEffect(() => {
    if (open) {
      setSource(initialSource);
      setDrafts(parseSourceIntoDrafts(initialSource));
    }
  }, [initialSource, open]);

  useEffect(() => {
    if (!open) return;
    const pending = pendingSelectionRef.current;
    const textarea = sourceRef.current;
    if (!pending || !textarea) return;
    textarea.focus();
    textarea.setSelectionRange(pending.start, pending.end);
    pendingSelectionRef.current = null;
  }, [open, source]);

  const previewMarkup = useMemo(() => {
    if (!source.trim()) {
      return {
        html: '',
        error: null as string | null,
      };
    }

    try {
      return {
        html: katex.renderToString(source, { displayMode: true, throwOnError: false }),
        error: null,
      };
    } catch (error) {
      return {
        html: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [source]);

  const updateDraft = <K extends keyof ParsedMathDrafts>(key: K, value: ParsedMathDrafts[K]) => {
    setDrafts((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  const setSourceWithCaret = (nextSource: string, start: number, end = start) => {
    pendingSelectionRef.current = { start, end };
    setSource(nextSource);
  };

  const insertSnippet = (snippet: string) => {
    const textarea = sourceRef.current;
    const selectionStart = textarea?.selectionStart ?? source.length;
    const selectionEnd = textarea?.selectionEnd ?? source.length;
    const selected = source.slice(selectionStart, selectionEnd);

    const withSelection = snippet.split('<selection>').join(selected || '');
    const cursorIndex = withSelection.indexOf('<cursor>');
    const insertText = cursorIndex >= 0 ? withSelection.replace('<cursor>', '') : withSelection;
    const nextSource = `${source.slice(0, selectionStart)}${insertText}${source.slice(selectionEnd)}`;
    const caretPosition = selectionStart + (cursorIndex >= 0 ? cursorIndex : insertText.length);

    setSourceWithCaret(nextSource, caretPosition);
  };

  const syncDraftsFromSource = () => {
    setDrafts(parseSourceIntoDrafts(source));
  };

  const applyDialog = () => {
    if (!source.trim()) return;
    onApply(source.trim());
  };

  const matrixRows = drafts.matrix.rows.length;
  const matrixCols = drafts.matrix.rows[0]?.length ?? 0;

  const updateMatrixCell = (rowIndex: number, colIndex: number, value: string) => {
    updateDraft('matrix', {
      ...drafts.matrix,
      rows: drafts.matrix.rows.map((row, currentRowIndex) => (
        currentRowIndex !== rowIndex
          ? row
          : row.map((cell, currentColIndex) => (currentColIndex === colIndex ? value : cell))
      )),
    });
  };

  const addMatrixRow = () => {
    updateDraft('matrix', {
      ...drafts.matrix,
      rows: [...drafts.matrix.rows, Array.from({ length: matrixCols || 2 }, () => '')],
    });
  };

  const removeMatrixRow = () => {
    if (matrixRows <= 1) return;
    updateDraft('matrix', {
      ...drafts.matrix,
      rows: drafts.matrix.rows.slice(0, -1),
    });
  };

  const addMatrixColumn = () => {
    updateDraft('matrix', {
      ...drafts.matrix,
      rows: drafts.matrix.rows.map((row) => [...row, '']),
    });
  };

  const removeMatrixColumn = () => {
    if (matrixCols <= 1) return;
    updateDraft('matrix', {
      ...drafts.matrix,
      rows: drafts.matrix.rows.map((row) => row.slice(0, -1)),
    });
  };

  const commonButtonClass = 'justify-start';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-7xl p-0 gap-0 overflow-hidden">
        <DialogHeader className="border-b border-border/40 px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            <Calculator size={16} />
            {mode === 'edit' ? 'Edit math block' : 'Insert math block'}
          </DialogTitle>
          <DialogDescription>
            Build LaTeX with visual helpers, symbols, and live preview, then insert the generated block into the note.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-[70vh] gap-0 lg:grid-cols-[380px_minmax(0,1fr)]">
          <div className="border-b border-border/30 lg:border-b-0 lg:border-r">
            <Tabs defaultValue="templates" className="h-full">
              <div className="border-b border-border/30 px-5 py-3">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="templates">Templates</TabsTrigger>
                  <TabsTrigger value="symbols">Symbols</TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="templates" className="h-[calc(70vh-57px)]">
                <ScrollArea className="h-full">
                  <div className="space-y-5 px-5 py-4">
                    <section className="space-y-3 rounded-xl border border-border/30 bg-card/35 p-4">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <Superscript size={15} />
                        Scripts
                      </div>
                      <div className="grid gap-3 sm:grid-cols-3">
                        <label className="space-y-1.5">
                          <span className="text-xs text-muted-foreground">Base</span>
                          <Input
                            value={drafts.script.base}
                            onChange={(event) => updateDraft('script', { ...drafts.script, base: event.target.value })}
                            placeholder="x"
                          />
                        </label>
                        <label className="space-y-1.5">
                          <span className="text-xs text-muted-foreground">Superscript</span>
                          <Input
                            value={drafts.script.superscript}
                            onChange={(event) => updateDraft('script', { ...drafts.script, superscript: event.target.value })}
                            placeholder="2"
                          />
                        </label>
                        <label className="space-y-1.5">
                          <span className="text-xs text-muted-foreground">Subscript</span>
                          <Input
                            value={drafts.script.subscript}
                            onChange={(event) => updateDraft('script', { ...drafts.script, subscript: event.target.value })}
                            placeholder="i"
                          />
                        </label>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        className={commonButtonClass}
                        onClick={() => insertSnippet(buildScriptSnippet(drafts.script))}
                      >
                        Insert script
                      </Button>
                    </section>

                    <section className="space-y-3 rounded-xl border border-border/30 bg-card/35 p-4">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <FunctionSquare size={15} />
                        Fraction
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="space-y-1.5">
                          <span className="text-xs text-muted-foreground">Numerator</span>
                          <Input
                            value={drafts.fraction.numerator}
                            onChange={(event) => updateDraft('fraction', { ...drafts.fraction, numerator: event.target.value })}
                            placeholder="a+b"
                          />
                        </label>
                        <label className="space-y-1.5">
                          <span className="text-xs text-muted-foreground">Denominator</span>
                          <Input
                            value={drafts.fraction.denominator}
                            onChange={(event) => updateDraft('fraction', { ...drafts.fraction, denominator: event.target.value })}
                            placeholder="c+d"
                          />
                        </label>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        className={commonButtonClass}
                        onClick={() => insertSnippet(buildFractionSnippet(drafts.fraction))}
                      >
                        Insert fraction
                      </Button>
                    </section>

                    <section className="space-y-3 rounded-xl border border-border/30 bg-card/35 p-4">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <SquareRadical size={15} />
                        Root
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="space-y-1.5">
                          <span className="text-xs text-muted-foreground">Degree</span>
                          <Input
                            value={drafts.root.degree}
                            onChange={(event) => updateDraft('root', { ...drafts.root, degree: event.target.value })}
                            placeholder="3"
                          />
                        </label>
                        <label className="space-y-1.5">
                          <span className="text-xs text-muted-foreground">Radicand</span>
                          <Input
                            value={drafts.root.radicand}
                            onChange={(event) => updateDraft('root', { ...drafts.root, radicand: event.target.value })}
                            placeholder="x+1"
                          />
                        </label>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        className={commonButtonClass}
                        onClick={() => insertSnippet(buildRootSnippet(drafts.root))}
                      >
                        Insert root
                      </Button>
                    </section>

                    <section className="space-y-3 rounded-xl border border-border/30 bg-card/35 p-4">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <Sigma size={15} />
                        Sum / Product
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="space-y-1.5">
                          <span className="text-xs text-muted-foreground">Operator</span>
                          <Select
                            value={drafts.operator.kind}
                            onValueChange={(value) => updateDraft('operator', { ...drafts.operator, kind: value as OperatorKind })}
                          >
                            <SelectTrigger className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="sum">Summation</SelectItem>
                              <SelectItem value="prod">Product</SelectItem>
                            </SelectContent>
                          </Select>
                        </label>
                        <label className="space-y-1.5">
                          <span className="text-xs text-muted-foreground">Index</span>
                          <Input
                            value={drafts.operator.index}
                            onChange={(event) => updateDraft('operator', { ...drafts.operator, index: event.target.value })}
                            placeholder="i"
                          />
                        </label>
                        <label className="space-y-1.5">
                          <span className="text-xs text-muted-foreground">From</span>
                          <Input
                            value={drafts.operator.lower}
                            onChange={(event) => updateDraft('operator', { ...drafts.operator, lower: event.target.value })}
                            placeholder="1"
                          />
                        </label>
                        <label className="space-y-1.5">
                          <span className="text-xs text-muted-foreground">To</span>
                          <Input
                            value={drafts.operator.upper}
                            onChange={(event) => updateDraft('operator', { ...drafts.operator, upper: event.target.value })}
                            placeholder="n"
                          />
                        </label>
                      </div>
                      <label className="space-y-1.5">
                        <span className="text-xs text-muted-foreground">Body</span>
                        <Input
                          value={drafts.operator.body}
                          onChange={(event) => updateDraft('operator', { ...drafts.operator, body: event.target.value })}
                          placeholder="a_i"
                        />
                      </label>
                      <Button
                        type="button"
                        variant="outline"
                        className={commonButtonClass}
                        onClick={() => insertSnippet(buildOperatorSnippet(drafts.operator))}
                      >
                        Insert operator
                      </Button>
                    </section>

                    <section className="space-y-3 rounded-xl border border-border/30 bg-card/35 p-4">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <Braces size={15} />
                        Brackets
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="space-y-1.5">
                          <span className="text-xs text-muted-foreground">Left</span>
                          <Select
                            value={drafts.bracket.left}
                            onValueChange={(value) => updateDraft('bracket', { ...drafts.bracket, left: value as BracketSide })}
                          >
                            <SelectTrigger className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="(">( )</SelectItem>
                              <SelectItem value="[">[ ]</SelectItem>
                              <SelectItem value="\\{">{`{ }`}</SelectItem>
                              <SelectItem value="|">| |</SelectItem>
                              <SelectItem value="\\langle">〈 〉</SelectItem>
                            </SelectContent>
                          </Select>
                        </label>
                        <label className="space-y-1.5">
                          <span className="text-xs text-muted-foreground">Right</span>
                          <Select
                            value={drafts.bracket.right}
                            onValueChange={(value) => updateDraft('bracket', { ...drafts.bracket, right: value as RightBracketSide })}
                          >
                            <SelectTrigger className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value=")">)</SelectItem>
                              <SelectItem value="]">]</SelectItem>
                              <SelectItem value="\\}">{`}`}</SelectItem>
                              <SelectItem value="|">|</SelectItem>
                              <SelectItem value="\\rangle">〉</SelectItem>
                            </SelectContent>
                          </Select>
                        </label>
                      </div>
                      <label className="space-y-1.5">
                        <span className="text-xs text-muted-foreground">Content</span>
                        <Input
                          value={drafts.bracket.content}
                          onChange={(event) => updateDraft('bracket', { ...drafts.bracket, content: event.target.value })}
                          placeholder="x+1"
                        />
                      </label>
                      <Button
                        type="button"
                        variant="outline"
                        className={commonButtonClass}
                        onClick={() => insertSnippet(buildBracketSnippet(drafts.bracket))}
                      >
                        Insert brackets
                      </Button>
                    </section>

                    <section className="space-y-3 rounded-xl border border-border/30 bg-card/35 p-4">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <Grid2x2 size={15} />
                        Matrix
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Select
                          value={drafts.matrix.environment}
                          onValueChange={(value) => updateDraft('matrix', { ...drafts.matrix, environment: value as MatrixEnvironment })}
                        >
                          <SelectTrigger className="w-[160px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="bmatrix">[ ] matrix</SelectItem>
                            <SelectItem value="pmatrix">( ) matrix</SelectItem>
                            <SelectItem value="vmatrix">| | matrix</SelectItem>
                            <SelectItem value="Bmatrix">{`{ } matrix`}</SelectItem>
                          </SelectContent>
                        </Select>
                        <Button type="button" variant="outline" size="sm" onClick={addMatrixColumn}>
                          <Plus size={13} />
                          Column
                        </Button>
                        <Button type="button" variant="outline" size="sm" onClick={removeMatrixColumn} disabled={matrixCols <= 1}>
                          <Minus size={13} />
                          Column
                        </Button>
                        <Button type="button" variant="outline" size="sm" onClick={addMatrixRow}>
                          <Plus size={13} />
                          Row
                        </Button>
                        <Button type="button" variant="outline" size="sm" onClick={removeMatrixRow} disabled={matrixRows <= 1}>
                          <Minus size={13} />
                          Row
                        </Button>
                      </div>
                      <div
                        className="grid gap-2"
                        style={{ gridTemplateColumns: `repeat(${Math.max(matrixCols, 1)}, minmax(0, 1fr))` }}
                      >
                        {drafts.matrix.rows.flatMap((row, rowIndex) => (
                          row.map((cell, colIndex) => (
                            <Input
                              key={`matrix-${rowIndex}-${colIndex}`}
                              value={cell}
                              onChange={(event) => updateMatrixCell(rowIndex, colIndex, event.target.value)}
                              placeholder={`${rowIndex + 1},${colIndex + 1}`}
                            />
                          ))
                        ))}
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        className={commonButtonClass}
                        onClick={() => insertSnippet(buildMatrixSnippet(drafts.matrix))}
                      >
                        Insert matrix
                      </Button>
                    </section>
                  </div>
                </ScrollArea>
              </TabsContent>

              <TabsContent value="symbols" className="h-[calc(70vh-57px)]">
                <ScrollArea className="h-full">
                  <div className="space-y-5 px-5 py-4">
                    <SymbolGrid title="Greek" items={GREEK_SYMBOLS} onInsert={insertSnippet} />
                    <Separator />
                    <SymbolGrid title="Relations" items={RELATION_SYMBOLS} onInsert={insertSnippet} />
                    <Separator />
                    <SymbolGrid title="Operators" items={OPERATOR_SYMBOLS} onInsert={insertSnippet} />
                    <Separator />
                    <SymbolGrid title="Functions" items={FUNCTION_SYMBOLS} onInsert={insertSnippet} />
                  </div>
                </ScrollArea>
              </TabsContent>
            </Tabs>
          </div>

          <div className="flex min-h-0 flex-col">
            <div className="border-b border-border/30 px-5 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => insertSnippet('\\frac{<selection>}{<cursor>}')}>
                  Fraction from selection
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => insertSnippet('^{<cursor>}')}>
                  Superscript
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => insertSnippet('_{<cursor>}')}>
                  Subscript
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => insertSnippet('\\sqrt{<selection>}<cursor>')}>
                  Root from selection
                </Button>
                <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={syncDraftsFromSource}>
                  Refresh builders from source
                </Button>
              </div>
            </div>

            <div className="grid min-h-0 flex-1 gap-0 xl:grid-cols-[minmax(0,1fr)_360px]">
              <div className="border-b border-border/30 xl:border-b-0 xl:border-r">
                <div className="flex items-center justify-between border-b border-border/30 px-5 py-3">
                  <div>
                    <div className="text-sm font-medium">Preview</div>
                    <div className="text-xs text-muted-foreground">KaTeX rendering of the current block source.</div>
                  </div>
                </div>
                <ScrollArea className="h-[32vh] xl:h-full">
                  <div className="px-5 py-5">
                    {source.trim() ? (
                      previewMarkup.html ? (
                        <div
                          className="rounded-xl border border-border/30 bg-card/35 px-5 py-6 text-[1.08rem]"
                          dangerouslySetInnerHTML={{ __html: previewMarkup.html }}
                        />
                      ) : (
                        <div className="rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-4 text-sm text-destructive">
                          {previewMarkup.error ?? 'Failed to render preview.'}
                        </div>
                      )
                    ) : (
                      <div className="rounded-xl border border-dashed border-border/40 px-4 py-10 text-center text-sm text-muted-foreground">
                        Start with a template, symbol button, or raw LaTeX in the source editor.
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </div>

              <div className="flex min-h-0 flex-col">
                <div className="flex items-center justify-between border-b border-border/30 px-5 py-3">
                  <div>
                    <div className="text-sm font-medium">LaTeX source</div>
                    <div className="text-xs text-muted-foreground">Unsupported syntax can always be edited directly here.</div>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {source.trim().length} chars
                  </div>
                </div>
                <div className="flex-1 px-5 py-4">
                  <Textarea
                    ref={sourceRef}
                    value={source}
                    onChange={(event) => setSource(event.target.value)}
                    placeholder="\\frac{x_i^2}{\\sqrt{n}}"
                    className="h-full min-h-[260px] resize-none font-mono text-sm leading-6"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="border-t border-border/30 px-5 py-4 gap-2 sm:justify-between">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={applyDialog} disabled={!source.trim()}>
            {mode === 'edit' ? 'Update math block' : 'Insert math block'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
