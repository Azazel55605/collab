import nerdamer from 'nerdamer/all';

export type MathPlotKind = '2d' | '3d';

export interface MathPlotDomain {
  min: number;
  max: number;
}

export interface MathPlot2DSpec {
  kind: '2d';
  expression: string;
  x: MathPlotDomain;
  samples: number;
  /** Optional manual y-axis limits. When omitted the range is auto-fit to the samples. */
  yDomain?: MathPlotDomain;
}

export interface MathPlot3DSpec {
  kind: '3d';
  expression: string;
  x: MathPlotDomain;
  y: MathPlotDomain;
  samples: number;
  /** Optional manual z-axis limits. When omitted the range is auto-fit to the samples. */
  zDomain?: MathPlotDomain;
}

export type MathPlotSpec = MathPlot2DSpec | MathPlot3DSpec;

export interface ParsedMathPlots {
  mathSource: string;
  plots: MathPlotSpec[];
  errors: string[];
}

export interface Sampled2DPlot {
  spec: MathPlot2DSpec;
  segments: Array<Array<{ x: number; y: number }>>;
  yDomain: MathPlotDomain;
}

export interface Sampled3DPlot {
  spec: MathPlot3DSpec;
  rows: Array<Array<{ x: number; y: number; z: number } | null>>;
  zDomain: MathPlotDomain;
  finiteCount: number;
}

export const PLOT_2D_MAX_SAMPLES = 1200;
export const PLOT_3D_MAX_SAMPLES = 90;
export const PLOT_MIN_SAMPLES = 16;
const DEFAULT_2D_DOMAIN: MathPlotDomain = { min: -10, max: 10 };
const DEFAULT_3D_DOMAIN: MathPlotDomain = { min: -5, max: 5 };

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function splitDirectiveArgs(input: string) {
  const parts: string[] = [];
  let current = '';
  let depth = 0;

  for (const char of input) {
    if (char === '{' || char === '(' || char === '[') depth += 1;
    if (char === '}' || char === ')' || char === ']') depth = Math.max(0, depth - 1);
    if (char === ',' && depth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseRange(value: string): MathPlotDomain | null {
  const match = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const min = Number(match[1]);
  const max = Number(match[2]);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) return null;
  return { min, max };
}

function parseAssignments(raw: string) {
  const map = new Map<string, string>();
  for (const part of splitDirectiveArgs(raw)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    map.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return map;
}

function stripPlotComments(source: string) {
  return source
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('%plot2d') && !line.trim().startsWith('%plot3d'))
    .join('\n')
    .trim();
}

function cleanupExpressionSource(source: string) {
  return source
    .trim()
    .replace(/\\begin\{(?:aligned|align|array|equation|gather|split)\}\s*/g, '')
    .replace(/\s*\\end\{(?:aligned|align|array|equation|gather|split)\}/g, '')
    .replace(/^&\s*/, '')
    .replace(/\s*\\\\\s*$/, '')
    .replace(/\s*&\s*=/g, '=')
    .trim();
}

function stripEquationLeftHandSide(source: string, target: 'y' | 'z') {
  const cleaned = cleanupExpressionSource(source);
  const escapedTarget = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const targetEquation = new RegExp(`^${escapedTarget}(?:\\s*\\([^)]*\\))?\\s*=\\s*(.+)$`);
  const functionEquation =
    target === 'z' ? /^f\s*\(\s*x\s*,\s*y\s*\)\s*=\s*(.+)$/ : /^f\s*\(\s*x\s*\)\s*=\s*(.+)$/;
  const targetMatch = cleaned.match(targetEquation);
  if (targetMatch) return cleanupExpressionSource(targetMatch[1]);
  const functionMatch = cleaned.match(functionEquation);
  if (functionMatch) return cleanupExpressionSource(functionMatch[1]);
  return cleaned;
}

function expressionCandidates(source: string) {
  const body = cleanupExpressionSource(stripPlotComments(source))
    .replace(/\\\\/g, '\n')
    .replace(/\\;/g, ' ')
    .replace(/\\,/g, ' ');

  return body
    .split(/\r?\n/)
    .map((line) => cleanupExpressionSource(line))
    .filter(Boolean);
}

function inferEquationExpression(source: string, target: 'y' | 'z') {
  const lines = expressionCandidates(source);
  for (const line of lines) {
    const expression = stripEquationLeftHandSide(line, target);
    if (expression !== cleanupExpressionSource(line)) return expression;
  }
  // Otherwise treat the math body as the surface/curve expression directly. A 3D
  // surface only needs to reference x or y (a body like `x^2+2` is constant in
  // y), so we no longer require both variables to be present.
  return lines.length > 0 ? cleanupExpressionSource(lines[0]) : null;
}

function parseSampleCount(value: string | undefined, fallback: number, max: number) {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, 16, max);
}

function isPlaceholderExpression(value: string | undefined) {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === 'expression' ||
    normalized === '<placeholder:expression>' ||
    normalized === '<placeholder:z>' ||
    normalized === '<placeholder:surface>'
  );
}

function parse2DDirective(raw: string, source: string): MathPlot2DSpec | string {
  const assignments = parseAssignments(raw);
  const explicitExpression = assignments.get('y');
  const expression =
    explicitExpression && !isPlaceholderExpression(explicitExpression)
      ? stripEquationLeftHandSide(explicitExpression, 'y')
      : inferEquationExpression(source, 'y');
  if (!expression) return '2D plot needs a y expression or inferable math body.';
  const x = assignments.get('x') ? parseRange(assignments.get('x') ?? '') : DEFAULT_2D_DOMAIN;
  if (!x) return '2D plot x range must look like x=-10..10.';
  return {
    kind: '2d',
    expression,
    x,
    samples: parseSampleCount(assignments.get('samples'), 600, PLOT_2D_MAX_SAMPLES),
  };
}

function parse3DDirective(raw: string, source: string): MathPlot3DSpec | string {
  const assignments = parseAssignments(raw);
  const explicitExpression = assignments.get('z');
  const expression =
    explicitExpression && !isPlaceholderExpression(explicitExpression)
      ? stripEquationLeftHandSide(explicitExpression, 'z')
      : inferEquationExpression(source, 'z');
  if (!expression) return '3D plot needs a z expression or inferable math body.';
  const x = assignments.get('x') ? parseRange(assignments.get('x') ?? '') : DEFAULT_3D_DOMAIN;
  const y = assignments.get('y') ? parseRange(assignments.get('y') ?? '') : DEFAULT_3D_DOMAIN;
  if (!x || !y) return '3D plot ranges must look like x=-5..5, y=-5..5.';
  return {
    kind: '3d',
    expression,
    x,
    y,
    samples: parseSampleCount(assignments.get('samples'), 60, PLOT_3D_MAX_SAMPLES),
  };
}

export function parseMathPlots(source: string): ParsedMathPlots {
  const plots: MathPlotSpec[] = [];
  const errors: string[] = [];

  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('%plot2d')) {
      const parsed = parse2DDirective(trimmed.slice('%plot2d'.length).trim(), source);
      if (typeof parsed === 'string') errors.push(parsed);
      else plots.push(parsed);
    }
    if (trimmed.startsWith('%plot3d')) {
      const parsed = parse3DDirective(trimmed.slice('%plot3d'.length).trim(), source);
      if (typeof parsed === 'string') errors.push(parsed);
      else plots.push(parsed);
    }
  }

  return {
    mathSource: stripPlotComments(source),
    plots,
    errors,
  };
}

function compileExpression(expression: string, variables: string[]) {
  const target = variables.includes('y') ? 'z' : 'y';
  const parsed = nerdamer.convertFromLaTeX(stripEquationLeftHandSide(expression, target));
  return parsed.buildFunction(variables);
}

export function samplePlot2D(spec: MathPlot2DSpec): Sampled2DPlot {
  const fn = compileExpression(spec.expression, ['x']);
  const points: Array<{ x: number; y: number } | null> = [];
  const sampleCount = clamp(spec.samples, 16, PLOT_2D_MAX_SAMPLES);
  const step = (spec.x.max - spec.x.min) / Math.max(1, sampleCount - 1);

  for (let index = 0; index < sampleCount; index += 1) {
    const x = spec.x.min + step * index;
    const y = fn(x);
    points.push(Number.isFinite(y) ? { x, y } : null);
  }

  const segments: Sampled2DPlot['segments'] = [];
  let current: Array<{ x: number; y: number }> = [];
  for (const point of points) {
    if (!point) {
      if (current.length > 1) segments.push(current);
      current = [];
      continue;
    }
    current.push(point);
  }
  if (current.length > 1) segments.push(current);

  const yValues = segments.flat().map((point) => point.y);
  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);
  const pad = minY === maxY ? 1 : (maxY - minY) * 0.08;

  const autoYDomain: MathPlotDomain =
    Number.isFinite(minY) && Number.isFinite(maxY)
      ? { min: minY - pad, max: maxY + pad }
      : { min: -1, max: 1 };

  return {
    spec,
    segments,
    yDomain: spec.yDomain && spec.yDomain.min < spec.yDomain.max ? spec.yDomain : autoYDomain,
  };
}

export function samplePlot3D(spec: MathPlot3DSpec): Sampled3DPlot {
  const fn = compileExpression(spec.expression, ['x', 'y']);
  const sampleCount = clamp(spec.samples, 16, PLOT_3D_MAX_SAMPLES);
  const xStep = (spec.x.max - spec.x.min) / Math.max(1, sampleCount - 1);
  const yStep = (spec.y.max - spec.y.min) / Math.max(1, sampleCount - 1);
  const rows: Sampled3DPlot['rows'] = [];
  const zValues: number[] = [];

  for (let yIndex = 0; yIndex < sampleCount; yIndex += 1) {
    const y = spec.y.min + yStep * yIndex;
    const row: Array<{ x: number; y: number; z: number } | null> = [];
    for (let xIndex = 0; xIndex < sampleCount; xIndex += 1) {
      const x = spec.x.min + xStep * xIndex;
      const z = fn(x, y);
      if (Number.isFinite(z)) {
        row.push({ x, y, z });
        zValues.push(z);
      } else {
        row.push(null);
      }
    }
    rows.push(row);
  }

  if (zValues.length === 0) {
    throw new Error('No finite points could be sampled for this surface.');
  }

  const minZ = Math.min(...zValues);
  const maxZ = Math.max(...zValues);
  const pad = minZ === maxZ ? 1 : (maxZ - minZ) * 0.08;

  const autoZDomain: MathPlotDomain = { min: minZ - pad, max: maxZ + pad };

  return {
    spec,
    rows,
    zDomain: spec.zDomain && spec.zDomain.min < spec.zDomain.max ? spec.zDomain : autoZDomain,
    finiteCount: zValues.length,
  };
}

export function buildDefaultPlotDirective(kind: MathPlotKind, source: string) {
  if (kind === '2d') {
    const expression = inferEquationExpression(source, 'y');
    return expression
      ? '%plot2d x=-10..10, samples=600'
      : '%plot2d y=<placeholder:expression>, x=-10..10, samples=600';
  }
  const expression = inferEquationExpression(source, 'z');
  return expression
    ? '%plot3d x=-5..5, y=-5..5, samples=60'
    : '%plot3d z=<placeholder:expression>, x=-5..5, y=-5..5, samples=60';
}
