import { EditorState, StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyMathSolverChoice,
  getActiveMathBlock,
  handleMathBlockShortcutKeydown,
  insertMathFraction,
  insertMathIntegral,
  insertMathMatrix,
  insertMathPlot2D,
  insertMathPlot3D,
  insertMathRoot,
  insertMathSubscript,
  insertMathSum,
  insertMathSuperscript,
  MATH_SOLVER_ACTION_EVENT,
  selectMathBlockContents,
  solveActiveMathInput,
} from './mathBlockCommands';
import { createSnippetSessionExtension } from './snippetEngine';

let views: EditorView[] = [];

function createView(doc: string, from = 0, to = from) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor: from, head: to },
      extensions: [createSnippetSessionExtension()],
    }),
  });
  views.push(view);
  return view;
}

afterEach(() => {
  for (const view of views) {
    const parent = view.dom.parentElement;
    view.destroy();
    parent?.remove();
  }
  views = [];
});

describe('mathBlockCommands', () => {
  it('detects the active display math block', () => {
    const view = createView('before\n$$\nx + 1\n$$\nafter', 10);

    expect(getActiveMathBlock(view)).toMatchObject({
      text: 'x + 1',
      innerFrom: 10,
      innerTo: 15,
    });
  });

  it('does not insert snippets outside a display math block', () => {
    const view = createView('outside math', 7);

    expect(insertMathFraction(view)).toBe(false);
    expect(view.state.doc.toString()).toBe('outside math');
  });

  it('wraps the selected math expression as a fraction', () => {
    const view = createView('before\n$$\nx + 1\n$$\nafter', 10, 15);

    expect(insertMathFraction(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('before\n$$\n\\frac{x + 1}{denominator}\n$$\nafter');
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      'denominator',
    );
  });

  it('wraps the contiguous math text before the cursor when there is no selection', () => {
    const view = createView('$$\nx+1\n$$', 6);

    expect(insertMathFraction(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('$$\n\\frac{x+1}{denominator}\n$$');
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      'denominator',
    );
  });

  it('wraps preceding math tokens for templates that accept existing content', () => {
    const rootView = createView('$$\nx+1\n$$', 6);
    expect(insertMathRoot(rootView)).toBe(true);
    expect(rootView.state.doc.toString()).toBe('$$\n\\sqrt{x+1}\n$$');

    const powerView = createView('$$\ny\n$$', 4);
    expect(insertMathSuperscript(powerView)).toBe(true);
    expect(powerView.state.doc.toString()).toBe('$$\n{y}^{power}\n$$');

    const subscriptView = createView('$$\na\n$$', 4);
    expect(insertMathSubscript(subscriptView)).toBe(true);
    expect(subscriptView.state.doc.toString()).toBe('$$\n{a}_{index}\n$$');

    const sumView = createView('$$\na_i\n$$', 6);
    expect(insertMathSum(sumView)).toBe(true);
    expect(sumView.state.doc.toString()).toBe('$$\n\\sum_{i=1}^{n} a_i\n$$');

    const integralView = createView('$$\nf(x)\n$$', 7);
    expect(insertMathIntegral(integralView)).toBe(true);
    expect(integralView.state.doc.toString()).toBe('$$\n\\int_{a}^{b} f(x)\\, dx\n$$');
  });

  it('inserts placeholder snippets inside an empty math selection', () => {
    const view = createView('$$\n\n$$', 3);

    expect(insertMathRoot(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('$$\n\\sqrt{radicand}\n$$');
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      'radicand',
    );
  });

  it('adds larger math structures through the same snippet session engine', () => {
    const view = createView('$$\ny\n$$', 3, 4);

    expect(insertMathSuperscript(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('$$\n{y}^{power}\n$$');
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      'power',
    );

    expect(insertMathMatrix(view)).toBe(true);
    expect(view.state.doc.toString()).toContain('\\begin{bmatrix}');
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      'a_{11}',
    );
  });

  it('selects display math block contents without selecting delimiters', () => {
    const view = createView('before\n$$\nx + 1\n$$\nafter', 10);

    expect(selectMathBlockContents(view)).toBe(true);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe(
      'x + 1',
    );
  });

  it('inserts 2D plot directives near the top of a math block', () => {
    const view = createView('$$\ny=\\sin(x)\n$$', 6);

    expect(insertMathPlot2D(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('$$\n%plot2d x=-10..10, samples=600\ny=\\sin(x)\n$$');
  });

  it('handles Ctrl+Alt math shortcuts from normalized physical key codes', () => {
    const view = createView('$$\ny=\\sin(x)\n$$', 6);
    const preventDefault = vi.fn();

    const handled = handleMathBlockShortcutKeydown(
      {
        key: '²',
        code: 'Digit2',
        ctrlKey: true,
        metaKey: false,
        altKey: true,
        shiftKey: false,
        preventDefault,
      },
      view,
    );

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(view.state.doc.toString()).toBe('$$\n%plot2d x=-10..10, samples=600\ny=\\sin(x)\n$$');
  });

  it('inserts 3D plot directives and updates existing directives', () => {
    const view = createView('$$\n%plot3d z=old, x=-1..1, y=-1..1\nz=x^2+y^2\n$$', 45);

    expect(insertMathPlot3D(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(
      '$$\n%plot3d x=-5..5, y=-5..5, samples=60\nz=x^2+y^2\n$$',
    );
  });

  it('appends an evaluated expression result on Ctrl+Enter command', () => {
    const view = createView('$$\n2+2\n$$', 6);

    expect(solveActiveMathInput(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('$$\n2+2 = 4\n$$');
  });

  it('appends an approximated expression result for approximate command', () => {
    const view = createView('$$\n\\frac{1}{2}\n$$', 13);

    expect(solveActiveMathInput(view, 'approximate')).toBe(true);
    expect(view.state.doc.toString()).toBe('$$\n\\frac{1}{2} \\approx 0.5\n$$');
  });

  it('appends an equation solution on Ctrl+Enter command', () => {
    const view = createView('$$\nx+1=3\n$$', 8);

    expect(solveActiveMathInput(view)).toBe(true);
    expect(view.state.doc.toString()).toBe('$$\nx+1=3\n\\Rightarrow x = 2\n$$');
  });

  it('opens a variable chooser for multi-variable equations', () => {
    const view = createView('$$\na*x+b=0\n$$', 11);
    let detail: unknown = null;
    const handler = (event: Event) => {
      detail = (event as CustomEvent).detail;
    };
    window.addEventListener(MATH_SOLVER_ACTION_EVENT, handler);

    expect(solveActiveMathInput(view)).toBe(true);

    window.removeEventListener(MATH_SOLVER_ACTION_EVENT, handler);
    expect(view.state.doc.toString()).toBe('$$\na*x+b=0\n$$');
    expect(detail).toMatchObject({
      source: 'a*x+b=0',
      mode: 'exact',
      variables: ['a', 'b', 'x'],
      range: { from: 3, to: 10 },
    });
  });
});

describe('math command ownership and read-only boundaries', () => {
  it('does not pair math delimiters inside code fences with real math blocks', () => {
    const doc = '```md\n$$\nexample\n```\n\n$$\n2+2\n$$';
    const view = createView(doc, doc.indexOf('2+2') + 3);
    expect(solveActiveMathInput(view)).toBe(true);
    expect(view.state.doc.toString()).toContain('2+2 = 4');
    view.dispatch({ selection: { anchor: doc.indexOf('example') } });
    expect(getActiveMathBlock(view)).toBeNull();
  });

  it('does not mutate read-only math through commands', () => {
    const view = createView('$$\n2+2\n$$', 6);
    view.dispatch({ effects: StateEffect.appendConfig.of(EditorState.readOnly.of(true)) });
    expect(solveActiveMathInput(view)).toBe(false);
    expect(insertMathFraction(view)).toBe(false);
    expect(insertMathPlot2D(view)).toBe(false);
    expect(view.state.doc.toString()).toBe('$$\n2+2\n$$');
  });

  it('rejects a chooser result for another pane or an edited document', () => {
    const view = createView('$$\nx+y=2\n$$', 8);
    const other = createView('$$\nx+y=2\n$$', 8);
    const detail = {
      view,
      document: view.state.doc,
      source: 'x+y=2',
      mode: 'exact' as const,
      variables: ['x', 'y'],
      range: { from: 3, to: 8 },
      anchorRect: null,
    };
    expect(applyMathSolverChoice(other, detail, 'x')).toBe(false);
    view.dispatch({ changes: { from: 3, to: 8, insert: 'x+y=3' } });
    expect(applyMathSolverChoice(view, detail, 'x')).toBe(false);
    expect(other.state.doc.toString()).toBe('$$\nx+y=2\n$$');
    expect(view.state.doc.toString()).toBe('$$\nx+y=3\n$$');
  });
});
