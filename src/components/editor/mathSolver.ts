import nerdamer from 'nerdamer/all';

export type MathSolveResult =
  { kind: 'expression'; latex: string } | { kind: 'equation'; variable: string; latex: string };

export type MathSolveMode = 'exact' | 'approximate';

export type MathInputAnalysis =
  | { kind: 'empty' }
  | { kind: 'expression'; variables: string[] }
  | { kind: 'equation'; variables: string[]; defaultVariable: string | null };

function parseMathSource(source: string) {
  const normalized = source
    .trim()
    .replace(/^\\Rightarrow\s*/, '')
    .replace(/^⇒\s*/, '');

  if (!normalized) return null;

  try {
    return nerdamer.convertFromLaTeX(normalized);
  } catch {
    return nerdamer(normalized);
  }
}

function toLatex(expression: string) {
  return nerdamer.convertToLaTeX(expression);
}

function toApproximateText(expression: string) {
  const decimal = nerdamer(expression).evaluate().text('decimals');
  const numeric = Number(decimal);
  if (!Number.isFinite(numeric)) return decimal;
  return Number.parseFloat(numeric.toPrecision(12)).toString();
}

function chooseSolveVariable(variables: string[]) {
  return variables.length === 1 ? variables[0] : null;
}

function formatEquationSolution(variable: string, solution: string, mode: MathSolveMode) {
  const parts = solution
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (mode === 'approximate' ? toApproximateText(part) : toLatex(part)));

  if (parts.length === 0) return null;
  const operator = mode === 'approximate' ? '\\approx' : '=';
  if (parts.length === 1) return `${variable} ${operator} ${parts[0]}`;
  return `${variable} ${mode === 'approximate' ? '\\approx' : '\\in'} \\left\\{${parts.join(', ')}\\right\\}`;
}

export function analyzeMathInput(source: string): MathInputAnalysis {
  const expression = parseMathSource(source);
  if (!expression) return { kind: 'empty' };

  const expressionText = expression.toString();
  const variables = expression.variables();
  const isEquation = expressionText.includes('=');

  if (isEquation) {
    return {
      kind: 'equation',
      variables,
      defaultVariable: chooseSolveVariable(variables),
    };
  }

  return { kind: 'expression', variables };
}

export function solveMathInput(
  source: string,
  mode: MathSolveMode = 'exact',
  solveVariable?: string,
): MathSolveResult | null {
  const expression = parseMathSource(source);
  if (!expression) return null;

  const expressionText = expression.toString();
  const variables = expression.variables();
  const isEquation = expressionText.includes('=');

  if (isEquation) {
    const variable = solveVariable ?? chooseSolveVariable(variables);
    if (!variable) return null;

    const solution = expression.solveFor(variable).toString();
    const latex = formatEquationSolution(variable, solution, mode);
    return latex ? { kind: 'equation', variable, latex } : null;
  }

  const evaluated =
    mode === 'approximate'
      ? toApproximateText(expression.toString())
      : expression.evaluate().toString();
  return {
    kind: 'expression',
    latex: mode === 'approximate' ? evaluated : toLatex(evaluated),
  };
}
