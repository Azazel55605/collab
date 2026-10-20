import nerdamer from 'nerdamer';

import {
  type MathPlot2DSpec,
  type MathPlot3DSpec,
  type MathPlotDomain,
  PLOT_2D_MAX_SAMPLES,
  PLOT_3D_MAX_SAMPLES,
  type Sampled2DPlot,
  type Sampled3DPlot,
  stripEquationLeftHandSide,
} from './mathPlotSpec';

function clamp(value: number, min: number, max: number) {
  return Math.floor(Math.min(Math.max(value, min), max));
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
