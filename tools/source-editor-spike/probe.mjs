/* global document, TextEncoder, requestAnimationFrame, performance, navigator, fetch */
import { defaultKeymap, history } from '@codemirror/commands';
import {
  defaultHighlightStyle,
  LanguageDescription,
  syntaxHighlighting,
  syntaxTree,
} from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { classHighlighter, highlightTree } from '@lezer/highlight';

const cases = [
  ['readme.txt', 'Plain text', 'One line of plain text.\n'],
  ['settings.json', 'JSON', '{"title": "α", "ready": true}\n'],
  ['parse.py', 'Python', 'def parse(value):\n    return value + 1\n'],
  ['main.c', 'C', '#include <stdio.h>\nint main(void) { return 0; }\n'],
  ['sample.h', 'C', 'int parse(const char *input);\n'],
  ['Program.cs', 'C#', 'public class Program { public int Value = 42; }\n'],
];

const editorHost = document.querySelector('#editor');
const reportArea = document.querySelector('#report');
const encoder = new TextEncoder();
const maximumBytes = 1024 * 1024;
const maximumLineBytes = 16 * 1024;
const maximumLines = 50_000;
const afterPaint = () =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
const elapsed = (start) => Math.round((performance.now() - start) * 10) / 10;

function admitsEditing(text) {
  if (encoder.encode(text).length > maximumBytes) return false;
  const lines = text.split('\n');
  return (
    lines.length <= maximumLines &&
    lines.every((line) => encoder.encode(line).length <= maximumLineBytes)
  );
}

function createState(text, language) {
  if (!admitsEditing(text)) throw new Error('Fixture exceeds editor admission policy');
  return EditorState.create({
    doc: text,
    extensions: [
      lineNumbers(),
      history(),
      keymap.of(defaultKeymap),
      syntaxHighlighting(defaultHighlightStyle),
      ...(language ? [language] : []),
    ],
  });
}

async function measure() {
  const report = { userAgent: navigator.userAgent, fixtures: [], exercises: {} };
  const states = new Map();
  let view;
  try {
    for (const original of ['a\r\nλ', 'a\r\nλ\r\n', '']) {
      const editorText = EditorState.create({ doc: original }).doc.toString();
      if (editorText !== original.replaceAll('\r\n', '\n')) {
        throw new Error('CodeMirror changed more than the line separators');
      }
    }
    report.exercises.canonicalEditorText = true;

    for (const [name, label, text] of cases) {
      const start = performance.now();
      const description = LanguageDescription.matchFilename(languages, name);
      if ((description?.name ?? 'Plain text') !== label) throw new Error('Wrong mode for ' + name);
      const language = await description?.load();
      const state = createState(text, language);
      if (!view) view = new EditorView({ state, parent: editorHost });
      else view.setState(state);
      await afterPaint();
      let highlightedRanges = 0;
      highlightTree(syntaxTree(view.state), classHighlighter, () => highlightedRanges++);
      if (highlightedRanges > 0 !== Boolean(language))
        throw new Error('Highlighting check failed for ' + name);
      states.set(name, { state, language });
      report.fixtures.push({ name, label, highlightedRanges, firstOpenMs: elapsed(start) });
    }

    const exercise = async (name, text, language) => {
      const openStart = performance.now();
      view.setState(createState(text, language));
      await afterPaint();
      const openMs = elapsed(openStart);
      const samples = [];
      for (let count = 0; count < 10; count++) {
        const start = performance.now();
        view.dispatch({ changes: { from: count, insert: ' ' } });
        await afterPaint();
        samples.push(elapsed(start));
      }
      if (view.state.doc.length !== text.length + samples.length)
        throw new Error('Typing lost text');
      report.exercises[name] = { bytes: encoder.encode(text).length, openMs, typingMs: samples };
    };

    const python = states.get('parse.py').language;
    await exercise('large', 'counter = counter + 1\n'.repeat(46_000 - 1), python);
    await exercise('longLine', 'value = "' + 'a'.repeat(maximumLineBytes - 24) + '"', python);

    for (const text of [
      'x'.repeat(maximumLineBytes + 1),
      'x\n'.repeat(maximumLines),
      ('x'.repeat(4095) + '\n').repeat(257),
    ]) {
      if (admitsEditing(text)) throw new Error('Oversized fixture was accepted into the editor');
    }
    report.exercises.rejectedOversizedFixtures = 3;

    const switches = [];
    for (const { state } of states.values()) {
      const start = performance.now();
      view.setState(state);
      await afterPaint();
      switches.push(elapsed(start));
      if (view.state.doc !== state.doc) throw new Error('Tab switch restored the wrong buffer');
    }
    report.exercises.tabSwitchMs = switches;
    return report;
  } finally {
    view?.destroy();
  }
}

let report;
try {
  report = await measure();
} catch (error) {
  report = { error: String(error) };
}
reportArea.textContent = JSON.stringify(report, null, 2);
await fetch('/result', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(report),
});
