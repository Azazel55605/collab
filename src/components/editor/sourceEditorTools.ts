import { completeAnyWord, ifNotIn } from '@codemirror/autocomplete';
import {
  foldedRanges,
  foldGutter,
  foldKeymap,
  syntaxTree,
  unfoldEffect,
} from '@codemirror/language';
import { type Diagnostic, linter, lintGutter, lintKeymap } from '@codemirror/lint';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';

const scriptedLanguages = ['javascript', 'jsx', 'typescript', 'tsx', 'python', 'go'];
const outlineLanguages = new Set([...scriptedLanguages, 'rust', 'c', 'cpp', 'java']);
const diagnosticLanguages = new Set([...scriptedLanguages, 'json', 'rust', 'css', 'xml', 'java']);
const wordCompletionLanguages = new Set(['c', 'cpp', 'csharp', 'java', 'rust']);
const streamLanguages = new Set(['', 'bash', 'csharp', 'toml', 'powershell']);

const declarations = new Set([
  'ClassDeclaration',
  'ClassDefinition',
  'ClassSpecifier',
  'EnumDeclaration',
  'EnumItem',
  'FunctionDecl',
  'FunctionDeclaration',
  'FunctionDefinition',
  'FunctionItem',
  'InterfaceDeclaration',
  'MethodDecl',
  'MethodDeclaration',
  'MethodDefinition',
  'ModuleItem',
  'NamespaceDefinition',
  'StructItem',
  'TraitItem',
  'TypeAliasDeclaration',
  'TypeDeclaration',
  'TypeSpec',
]);

export interface SourceSymbol {
  name: string;
  from: number;
  to: number;
  line: number;
}

export function supportsSourceOutline(language: string) {
  return outlineLanguages.has(language);
}

export function supportsSourceDiagnostics(language: string) {
  return diagnosticLanguages.has(language);
}

export function sourceSymbols(state: EditorState): SourceSymbol[] {
  const symbols: SourceSymbol[] = [];
  syntaxTree(state).iterate({
    enter: (ref) => {
      if (symbols.length >= 150) return false;
      if (!declarations.has(ref.name)) return;
      const node = ref.node;
      const name =
        node.getChild('VariableDefinition') ??
        node.getChild('PropertyDefinition') ??
        node.getChild('TypeDefinition') ??
        node.getChild('BoundIdentifier') ??
        node.getChild('TypeIdentifier') ??
        node.getChild('DefName') ??
        node.getChild('Definition') ??
        node.getChild('VariableName') ??
        node.getChild('PropertyName') ??
        node.getChild('TypeName') ??
        node.getChild('Identifier') ??
        node.getChild('FunctionDeclarator')?.getChild('Identifier');
      if (name && name.to - name.from <= 128) {
        symbols.push({
          name: state.sliceDoc(name.from, name.to),
          from: name.from,
          to: name.to,
          line: state.doc.lineAt(name.from).number,
        });
      }
    },
  });
  return symbols;
}

export function sourceSyntaxDiagnostics(view: Pick<EditorView, 'state'>): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const tree = syntaxTree(view.state);
  tree.iterate({
    enter: ({ from, to, type }) => {
      if (diagnostics.length >= 50) return false;
      // An unfinished parse can end with a temporary recovery node.
      if (!type.isError || (to === tree.length && tree.length < view.state.doc.length)) return;
      const previous = diagnostics[diagnostics.length - 1];
      if (previous?.from === from && previous.to === to) return false;
      diagnostics.push({
        from,
        to,
        severity: 'error',
        source: 'Syntax',
        message: from === to ? 'Expected syntax here.' : 'Unexpected or invalid syntax.',
      });
      return false;
    },
  });
  return diagnostics;
}

export function sourceEditorTools(language: string): Extension {
  return [
    wordCompletionLanguages.has(language)
      ? EditorState.languageData.of(() => [
          {
            autocomplete: ifNotIn(
              ['String', 'StringLiteral', 'LineComment', 'BlockComment'],
              completeAnyWord,
            ),
          },
        ])
      : [],
    !streamLanguages.has(language) ? [foldGutter(), keymap.of(foldKeymap)] : [],
    supportsSourceDiagnostics(language)
      ? [
          linter(sourceSyntaxDiagnostics, {
            delay: 350,
            needsRefresh: (update) => syntaxTree(update.startState) !== syntaxTree(update.state),
          }),
          lintGutter(),
          keymap.of(lintKeymap),
        ]
      : [],
    EditorView.theme({
      '.cm-foldGutter .cm-gutterElement': { color: 'var(--muted-foreground)' },
      '.cm-foldPlaceholder': {
        backgroundColor: 'var(--muted)',
        borderColor: 'var(--border)',
        color: 'var(--foreground)',
      },
      '.cm-panel.cm-panel-lint': {
        backgroundColor: 'var(--background)',
        color: 'var(--foreground)',
      },
    }),
  ];
}

export function revealSourceRange(view: EditorView, from: number, to = from) {
  const length = view.state.doc.length;
  const anchor = Math.min(from, length);
  const head = Math.min(to, length);
  const effects = [EditorView.scrollIntoView(anchor, { y: 'center' })];
  foldedRanges(view.state).between(anchor, head, (from, to) => {
    effects.push(unfoldEffect.of({ from, to }));
  });
  view.dispatch({ selection: { anchor, head }, effects });
  view.focus();
}
