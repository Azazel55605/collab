import type { CircuitSweepOutput, CircuitSweepResult } from '../types/circuitRuntime';

const TRACE_COLORS = ['#22d3ee', '#fbbf24', '#a78bfa', '#fb7185', '#34d399', '#fb923c'];

export function circuitSweepOutputKey(output: CircuitSweepOutput): string {
  return output.kind === 'node-voltage' ? `node:${output.node}` : `component:${output.component}`;
}

export function circuitSweepTraceUnit(output: CircuitSweepOutput): 'V' | 'A' {
  return output.kind === 'node-voltage' ? 'V' : 'A';
}

export function circuitSweepTraceLabel(
  result: Pick<CircuitSweepResult, 'sourceMap'>,
  output: CircuitSweepOutput,
): string {
  const probe = result.sourceMap.probes.find((candidate) =>
    output.kind === 'node-voltage'
      ? candidate.kind === 'node-voltage' && candidate.electricalNode === output.node
      : candidate.kind === 'branch-current' && candidate.component === output.component,
  );
  if (probe?.label) return probe.label;
  if (probe?.probeId) return probe.probeId;
  return output.kind === 'node-voltage' ? `Node ${output.node}` : output.component;
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function buildCircuitSweepCsv(result: CircuitSweepResult, sourceLabel?: string): string {
  const header = [
    `${sourceLabel || result.source} (source value)`,
    ...result.traces.map(
      (trace) =>
        `${circuitSweepTraceLabel(result, trace.output)} (${circuitSweepTraceUnit(trace.output)})`,
    ),
  ]
    .map(csvCell)
    .join(',');
  const rows = result.sourceValues.map((sourceValue, index) =>
    [sourceValue, ...result.traces.map((trace) => trace.values[index])]
      .map((value) => (Number.isFinite(value) ? String(value) : ''))
      .join(','),
  );
  return `${header}\n${rows.join('\n')}\n`;
}

function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function extent(values: number[]): [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    const padding = Math.max(Math.abs(min) * 0.05, 1e-9);
    return [min - padding, max + padding];
  }
  const padding = (max - min) * 0.08;
  return [min - padding, max + padding];
}

function axis(value: number): string {
  const absolute = Math.abs(value);
  if (absolute !== 0 && (absolute >= 1e4 || absolute < 1e-3)) return value.toExponential(2);
  return Number(value.toPrecision(4)).toString();
}

export function buildCircuitSweepSvg(result: CircuitSweepResult, sourceLabel?: string): string {
  const width = 1200;
  const legendColumns = 4;
  const legendRows = Math.max(1, Math.ceil(result.traces.length / legendColumns));
  const top = 54 + legendRows * 24;
  const plotHeight = 462;
  const bottom = 66;
  const height = top + plotHeight + bottom;
  const left = 104;
  const voltageValues = result.traces.flatMap((trace) =>
    trace.output.kind === 'node-voltage' ? trace.values : [],
  );
  const currentValues = result.traces.flatMap((trace) =>
    trace.output.kind === 'component-current' ? trace.values : [],
  );
  const dual = voltageValues.length > 0 && currentValues.length > 0;
  const right = dual ? 104 : 42;
  const plotWidth = width - left - right;
  const [xMin, xMax] = extent(result.sourceValues);
  const [primaryMin, primaryMax] = extent(voltageValues.length > 0 ? voltageValues : currentValues);
  const [currentMin, currentMax] = extent(currentValues);
  const x = (value: number) => left + ((value - xMin) / (xMax - xMin)) * plotWidth;
  const scaleY = (value: number, min: number, max: number) =>
    top + (1 - (value - min) / (max - min)) * plotHeight;
  const y = (value: number, output: CircuitSweepOutput) =>
    dual && output.kind === 'component-current'
      ? scaleY(value, currentMin, currentMax)
      : scaleY(value, primaryMin, primaryMax);
  const ticks = Array.from({ length: 6 }, (_, index) => index / 5);
  const grid = ticks
    .map((fraction) => {
      const tickY = top + fraction * plotHeight;
      const primary = primaryMax - fraction * (primaryMax - primaryMin);
      const secondary = currentMax - fraction * (currentMax - currentMin);
      return `<line x1="${left}" x2="${width - right}" y1="${tickY}" y2="${tickY}" stroke="#2d3442"/><text x="${left - 14}" y="${tickY + 4}" text-anchor="end">${axis(primary)} ${voltageValues.length > 0 ? 'V' : 'A'}</text>${dual ? `<text x="${width - right + 14}" y="${tickY + 4}">${axis(secondary)} A</text>` : ''}`;
    })
    .join('');
  const xTicks = ticks
    .map((fraction) => {
      const tickX = left + fraction * plotWidth;
      const value = xMin + fraction * (xMax - xMin);
      return `<line x1="${tickX}" x2="${tickX}" y1="${top}" y2="${height - bottom}" stroke="#2d3442"/><text x="${tickX}" y="${height - bottom + 28}" text-anchor="middle">${axis(value)}</text>`;
    })
    .join('');
  const traces = result.traces
    .map((trace, traceIndex) => {
      const points = result.sourceValues
        .map((sourceValue, index) =>
          Number.isFinite(sourceValue) && Number.isFinite(trace.values[index])
            ? `${x(sourceValue).toFixed(3)},${y(trace.values[index], trace.output).toFixed(3)}`
            : null,
        )
        .filter((point): point is string => point !== null)
        .join(' ');
      return `<polyline points="${points}" fill="none" stroke="${TRACE_COLORS[traceIndex % TRACE_COLORS.length]}" stroke-width="2.5"/>`;
    })
    .join('');
  const legend = result.traces
    .map((trace, index) => {
      const xPosition = left + (index % legendColumns) * 245;
      const yPosition = 46 + Math.floor(index / legendColumns) * 24;
      return `<g transform="translate(${xPosition} ${yPosition})"><line x2="18" y1="-4" y2="-4" stroke="${TRACE_COLORS[index % TRACE_COLORS.length]}" stroke-width="3"/><text x="26">${xml(circuitSweepTraceLabel(result, trace.output))} (${circuitSweepTraceUnit(trace.output)})</text></g>`;
    })
    .join('');
  const title = xml(`${sourceLabel || result.source} DC sweep`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#0b0e14"/><style>text{fill:#a8afbd;font:12px ui-monospace,monospace;letter-spacing:0}.title{fill:#f0f2f6;font:600 16px system-ui,sans-serif}.axis-title{font:13px system-ui,sans-serif}</style><text class="title" x="${left}" y="22">${title}</text>${legend}<g>${grid}${xTicks}<rect x="${left}" y="${top}" width="${plotWidth}" height="${plotHeight}" fill="none" stroke="#4a5262"/>${traces}</g><text class="axis-title" x="${left + plotWidth / 2}" y="${height - 12}" text-anchor="middle">${xml(sourceLabel || result.source)} (source value)</text></svg>`;
}

export function utf8ToBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
