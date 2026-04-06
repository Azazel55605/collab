/**
 * Safe math expression evaluator.
 * Validates input against an allowlist before using `new Function`.
 * Supports: arithmetic (+,-,*,/,**,%), parentheses, and named math functions.
 *
 * Examples: "2+2" → 4, "sqrt(2)*pi" → 4.44..., "2^8" → 256
 */

const SAFE_IDENTIFIERS =
  /\b(sqrt|round|floor|ceil|abs|log|log2|log10|sin|cos|tan|asin|acos|atan|atan2|pow|min|max|pi|e|inf)\b/g;

const PREAMBLE = `
  const pi = Math.PI, e = Math.E, inf = Infinity;
  const sqrt = Math.sqrt, round = Math.round, floor = Math.floor,
        ceil = Math.ceil, abs = Math.abs, log = Math.log,
        log2 = Math.log2, log10 = Math.log10,
        sin = Math.sin, cos = Math.cos, tan = Math.tan,
        asin = Math.asin, acos = Math.acos, atan = Math.atan, atan2 = Math.atan2,
        pow = Math.pow, min = Math.min, max = Math.max;
`;

export function evalMath(expr: string): number | null {
  if (!expr.trim()) return null;

  // Replace ^ with ** for intuitive exponentiation
  const normalized = expr.replace(/\^/g, '**');

  // Strip known-safe identifiers, then check only numeric/operator chars remain
  const stripped = normalized.replace(SAFE_IDENTIFIERS, '');
  if (!/^[0-9+\-*/().%\s,]*$/.test(stripped)) return null;

  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`${PREAMBLE}; return (${normalized});`);
    const result = fn() as unknown;
    if (typeof result !== 'number' || !isFinite(result)) return null;
    // Trim floating-point noise (e.g. 0.1+0.2 → 0.3 not 0.30000000000000004)
    const rounded = parseFloat(result.toPrecision(12));
    return rounded;
  } catch {
    return null;
  }
}

/** Format a number for display — trim trailing zeros after decimal */
export function formatMathResult(n: number): string {
  // Use toPrecision to avoid scientific notation for common results
  const s = String(n);
  return s;
}
