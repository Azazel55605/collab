import { EditorSelection, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';

import {
  type EditorShortcutEventLike,
  getEditorShortcutKey,
  hasPrimaryModifier,
} from './editorShortcutKeys';
import { buildDefaultPlotDirective, type MathPlotKind } from './mathPlotSpec';
import { analyzeMathInput, type MathSolveMode, solveMathInput } from './mathSolver';
import { insertSnippetTemplate } from './snippetEngine';

export type MathBlockRange = {
  from: number;
  to: number;
  innerFrom: number;
  innerTo: number;
  text: string;
};

type MathSnippetCommand = {
  key: string;
  run: (view: EditorView) => boolean;
};

export const MATH_SOLVER_ACTION_EVENT = 'editor:math-solver-action';

export type MathSolverActionDetail = {
  source: string;
  mode: MathSolveMode;
  variables: string[];
  range: { from: number; to: number };
  anchorRect: { left: number; right: number; top: number; bottom: number } | null;
};

function isMathDelimiterLine(text: string) {
  return text.trim() === '$$';
}

export function getMathBlockAtPosition(view: EditorView, position: number): MathBlockRange | null {
  const lineAtPosition = view.state.doc.lineAt(position);
  const delimiterLines: number[] = [];

  for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber += 1) {
    if (isMathDelimiterLine(view.state.doc.line(lineNumber).text)) {
      delimiterLines.push(lineNumber);
    }
  }

  for (let index = 0; index < delimiterLines.length - 1; index += 2) {
    const startLineNumber = delimiterLines[index];
    const endLineNumber = delimiterLines[index + 1];
    if (lineAtPosition.number < startLineNumber || lineAtPosition.number > endLineNumber) continue;

    const startLine = view.state.doc.line(startLineNumber);
    const endLine = view.state.doc.line(endLineNumber);
    const innerFrom =
      startLineNumber < endLineNumber
        ? view.state.doc.line(startLineNumber + 1).from
        : startLine.to;
    const innerTo =
      endLineNumber > startLineNumber ? view.state.doc.line(endLineNumber - 1).to : startLine.to;

    return {
      from: startLine.from,
      to: endLine.to,
      innerFrom,
      innerTo,
      text: innerFrom <= innerTo ? view.state.sliceDoc(innerFrom, innerTo) : '',
    };
  }

  return null;
}

export function getActiveMathBlock(view: EditorView): MathBlockRange | null {
  const selection = view.state.selection.main;
  const block = getMathBlockAtPosition(view, selection.from);
  if (!block) return null;
  if (selection.to > block.to) return null;
  return block;
}

function clampRangeToMathInner(view: EditorView, block: MathBlockRange) {
  const selection = view.state.selection.main;
  const from = Math.min(Math.max(selection.from, block.innerFrom), block.innerTo);
  const to = Math.min(Math.max(selection.to, block.innerFrom), block.innerTo);
  return {
    from,
    to,
  };
}

function getMathTokenBeforeCursor(view: EditorView, block: MathBlockRange) {
  const selection = view.state.selection.main;
  if (!selection.empty || selection.from <= block.innerFrom) return null;

  const line = view.state.doc.lineAt(selection.from);
  const fromLimit = Math.max(line.from, block.innerFrom);
  const beforeCursor = view.state.sliceDoc(fromLimit, selection.from);
  const match = beforeCursor.match(/\S+$/);
  if (!match || match.index === undefined) return null;

  return {
    from: fromLimit + match.index,
    to: selection.from,
  };
}

function getMathCommandRange(view: EditorView, block: MathBlockRange) {
  const range = clampRangeToMathInner(view, block);
  if (range.from < range.to) return range;
  return getMathTokenBeforeCursor(view, block) ?? range;
}

function trimRange(view: EditorView, range: { from: number; to: number }) {
  let from = range.from;
  let to = range.to;
  while (from < to && /\s/.test(view.state.sliceDoc(from, from + 1))) from += 1;
  while (to > from && /\s/.test(view.state.sliceDoc(to - 1, to))) to -= 1;
  return { from, to };
}

function getMathSolveRange(view: EditorView, block: MathBlockRange) {
  const selectionRange = clampRangeToMathInner(view, block);
  if (selectionRange.from < selectionRange.to) return trimRange(view, selectionRange);

  const cursor = view.state.selection.main.from;
  const line = view.state.doc.lineAt(cursor);
  const lineRange = trimRange(view, {
    from: Math.max(line.from, block.innerFrom),
    to: Math.min(line.to, block.innerTo),
  });
  if (lineRange.from < lineRange.to) return lineRange;

  return trimRange(view, { from: block.innerFrom, to: block.innerTo });
}

function selectedMathText(view: EditorView, range: { from: number; to: number }) {
  return range.from < range.to ? view.state.sliceDoc(range.from, range.to) : '';
}

function getAnchorRectAtPosition(view: EditorView, position: number) {
  try {
    return view.coordsAtPos(position);
  } catch {
    return null;
  }
}

function insertMathTemplate(view: EditorView, buildTemplate: (selected: string) => string) {
  const block = getActiveMathBlock(view);
  if (!block) return false;

  const range = getMathCommandRange(view, block);
  const selected = selectedMathText(view, range);
  insertSnippetTemplate(view, buildTemplate(selected), range);
  return true;
}

export function insertMathFraction(view: EditorView) {
  return insertMathTemplate(view, (selected) =>
    selected
      ? `\\frac{${selected}}{<placeholder:denominator>}<cursor>`
      : '\\frac{<placeholder:numerator>}{<placeholder:denominator>}<cursor>',
  );
}

export function insertMathRoot(view: EditorView) {
  return insertMathTemplate(view, (selected) =>
    selected ? `\\sqrt{${selected}}<cursor>` : '\\sqrt{<placeholder:radicand>}<cursor>',
  );
}

export function insertMathSuperscript(view: EditorView) {
  return insertMathTemplate(view, (selected) =>
    selected
      ? `{${selected}}^{<placeholder:power>}<cursor>`
      : '<placeholder:base>^{<placeholder:power>}<cursor>',
  );
}

export function insertMathSubscript(view: EditorView) {
  return insertMathTemplate(view, (selected) =>
    selected
      ? `{${selected}}_{<placeholder:index>}<cursor>`
      : '<placeholder:base>_{<placeholder:index>}<cursor>',
  );
}

export function insertMathSum(view: EditorView) {
  return insertMathTemplate(view, (selected) =>
    selected
      ? `\\sum_{<placeholder:i=1>}^{<placeholder:n>} ${selected}<cursor>`
      : '\\sum_{<placeholder:i=1>}^{<placeholder:n>} <placeholder:expression><cursor>',
  );
}

export function insertMathIntegral(view: EditorView) {
  return insertMathTemplate(view, (selected) =>
    selected
      ? `\\int_{<placeholder:a>}^{<placeholder:b>} ${selected}\\, d<placeholder:x><cursor>`
      : '\\int_{<placeholder:a>}^{<placeholder:b>} <placeholder:integrand>\\, d<placeholder:x><cursor>',
  );
}

export function insertMathMatrix(view: EditorView) {
  return insertMathTemplate(
    view,
    () =>
      '\\begin{bmatrix}\n' +
      '<placeholder:a_{11}> & <placeholder:a_{12}> \\\\\n' +
      '<placeholder:a_{21}> & <placeholder:a_{22}>\n' +
      '\\end{bmatrix}<cursor>',
  );
}

export function insertOrUpdateMathPlotDirective(view: EditorView, kind: MathPlotKind) {
  const block = getActiveMathBlock(view);
  if (!block) return false;

  const prefix = kind === '2d' ? '%plot2d' : '%plot3d';
  const directive = buildDefaultPlotDirective(kind, block.text);
  const startLine = view.state.doc.lineAt(block.innerFrom).number;
  const endLine = view.state.doc.lineAt(block.innerTo).number;

  for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
    const line = view.state.doc.line(lineNumber);
    if (line.text.trim().startsWith(prefix)) {
      insertSnippetTemplate(view, directive, { from: line.from, to: line.to });
      return true;
    }
  }

  insertSnippetTemplate(view, `${directive}\n`, { from: block.innerFrom, to: block.innerFrom });
  return true;
}

export function insertMathPlot2D(view: EditorView) {
  return insertOrUpdateMathPlotDirective(view, '2d');
}

export function insertMathPlot3D(view: EditorView) {
  return insertOrUpdateMathPlotDirective(view, '3d');
}

export function selectMathBlockContents(view: EditorView) {
  const block = getActiveMathBlock(view);
  if (!block) return false;
  view.dispatch({
    selection: EditorSelection.single(block.innerFrom, block.innerTo),
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

export function solveActiveMathInput(view: EditorView, mode: MathSolveMode = 'exact') {
  const block = getActiveMathBlock(view);
  if (!block) return false;

  const range = getMathSolveRange(view, block);
  const source = selectedMathText(view, range);
  if (!source.trim()) return true;

  const analysis = analyzeMathInput(source);
  if (analysis.kind === 'equation' && !analysis.defaultVariable && analysis.variables.length > 1) {
    window.dispatchEvent(
      new CustomEvent<MathSolverActionDetail>(MATH_SOLVER_ACTION_EVENT, {
        detail: {
          source,
          mode,
          variables: analysis.variables,
          range,
          anchorRect: getAnchorRectAtPosition(view, range.to),
        },
      }),
    );
    return true;
  }

  const result = solveMathInput(source, mode);
  if (!result) return true;

  const insert =
    result.kind === 'equation'
      ? `\n\\Rightarrow ${result.latex}`
      : mode === 'approximate'
        ? ` \\approx ${result.latex}`
        : ` = ${result.latex}`;
  view.dispatch({
    changes: { from: range.to, insert },
    selection: { anchor: range.to + insert.length },
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

export function handleMathBlockShortcutKeydown(event: EditorShortcutEventLike, view: EditorView) {
  if (!hasPrimaryModifier(event)) return false;

  const key = getEditorShortcutKey(event);
  let handled = false;

  if (!event.altKey && !event.shiftKey && key === 'enter') {
    handled = solveActiveMathInput(view);
  } else if (event.altKey && !event.shiftKey) {
    switch (key) {
      case 'enter':
        handled = solveActiveMathInput(view, 'approximate');
        break;
      case 'f':
        handled = insertMathFraction(view);
        break;
      case 'r':
        handled = insertMathRoot(view);
        break;
      case 'p':
        handled = insertMathSuperscript(view);
        break;
      case 'u':
        handled = insertMathSubscript(view);
        break;
      case 'g':
        handled = insertMathSum(view);
        break;
      case 'e':
        handled = insertMathIntegral(view);
        break;
      case 'x':
        handled = insertMathMatrix(view);
        break;
      case 'a':
        handled = selectMathBlockContents(view);
        break;
      case '2':
        handled = insertMathPlot2D(view);
        break;
      case '3':
        handled = insertMathPlot3D(view);
        break;
      default:
        break;
    }
  }

  if (!handled) return false;
  event.preventDefault();
  return true;
}

export function createMathBlockShortcutExtension(): Extension {
  const commands: MathSnippetCommand[] = [
    { key: 'Mod-Enter', run: solveActiveMathInput },
    { key: 'Mod-Alt-Enter', run: (view) => solveActiveMathInput(view, 'approximate') },
    { key: 'Mod-Alt-f', run: insertMathFraction },
    { key: 'Mod-Alt-r', run: insertMathRoot },
    { key: 'Mod-Alt-p', run: insertMathSuperscript },
    { key: 'Mod-Alt-u', run: insertMathSubscript },
    { key: 'Mod-Alt-g', run: insertMathSum },
    { key: 'Mod-Alt-e', run: insertMathIntegral },
    { key: 'Mod-Alt-x', run: insertMathMatrix },
    { key: 'Mod-Alt-a', run: selectMathBlockContents },
    { key: 'Mod-Alt-2', run: insertMathPlot2D },
    { key: 'Mod-Alt-3', run: insertMathPlot3D },
  ];

  return keymap.of(commands);
}
