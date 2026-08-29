import { describe, expect, it } from 'vitest';

import {
  buildDefaultPlotDirective,
  parseMathPlots,
  samplePlot2D,
  samplePlot3D,
} from './mathPlotSpec';

describe('mathPlotSpec', () => {
  it('parses inferred 2D directives', () => {
    expect(parseMathPlots('%plot2d x=-10..10, samples=600\ny=\\sin(x)')).toMatchObject({
      mathSource: 'y=\\sin(x)',
      plots: [{ kind: '2d', expression: '\\sin(x)', x: { min: -10, max: 10 }, samples: 600 }],
      errors: [],
    });
  });

  it('parses explicit 2D directives', () => {
    expect(parseMathPlots('%plot2d y=\\cos(x), x=-3.14..3.14')).toMatchObject({
      plots: [{ kind: '2d', expression: '\\cos(x)', x: { min: -3.14, max: 3.14 } }],
    });
  });

  it('parses 3D directives and clamps excessive samples', () => {
    expect(parseMathPlots('%plot3d z=x^2+y^2, x=-5..5, y=-4..4, samples=999')).toMatchObject({
      plots: [
        {
          kind: '3d',
          expression: 'x^2+y^2',
          x: { min: -5, max: 5 },
          y: { min: -4, max: 4 },
          samples: 90,
        },
      ],
      errors: [],
    });
  });

  it('infers 3D expressions from aligned and function-style equations', () => {
    expect(parseMathPlots('%plot3d x=-5..5, y=-5..5\nz &= \\sin(x+y)\\\\')).toMatchObject({
      plots: [{ kind: '3d', expression: '\\sin(x+y)' }],
    });
    expect(
      parseMathPlots(
        '%plot3d x=-5..5, y=-5..5\n\\begin{aligned} z &= \\sin(\\sqrt{x^2+y^2}) \\end{aligned}',
      ),
    ).toMatchObject({
      plots: [{ kind: '3d', expression: '\\sin(\\sqrt{x^2+y^2})' }],
    });
    expect(parseMathPlots('%plot3d x=-5..5, y=-5..5\nz(x,y)=x^2+y^2')).toMatchObject({
      plots: [{ kind: '3d', expression: 'x^2+y^2' }],
    });
  });

  it('normalizes explicit 3D equation expressions before sampling', () => {
    const parsed = parseMathPlots('%plot3d z=z=x^2+y^2, x=-2..2, y=-2..2, samples=20');
    expect(parsed).toMatchObject({
      plots: [{ kind: '3d', expression: 'x^2+y^2' }],
      errors: [],
    });
    expect(samplePlot3D(parsed.plots[0] as never).finiteCount).toBe(400);
  });

  it('ignores placeholder 3D directive expressions and reads the math body', () => {
    expect(parseMathPlots('%plot3d z=expression, x=-5..5, y=-5..5\nz=\\sin(x+y)')).toMatchObject({
      plots: [{ kind: '3d', expression: '\\sin(x+y)' }],
      errors: [],
    });
    expect(
      parseMathPlots('%plot3d z=<placeholder:expression>, x=-5..5, y=-5..5\nz=x^2+y^2'),
    ).toMatchObject({
      plots: [{ kind: '3d', expression: 'x^2+y^2' }],
      errors: [],
    });
  });

  it('allows bare x/y expressions for inferred 3D plots', () => {
    expect(parseMathPlots('%plot3d x=-5..5, y=-5..5\nx^2+y^2')).toMatchObject({
      plots: [{ kind: '3d', expression: 'x^2+y^2' }],
      errors: [],
    });
  });

  it('infers a single-variable 3D surface from the math body', () => {
    // A placeholder z= directive over a body that only uses x must still read
    // the body and sample a valid (y-constant) surface.
    const parsed = parseMathPlots('%plot3d z=expression, x=-5..5, y=-5..5, samples=20\nx^2+2');
    expect(parsed).toMatchObject({
      plots: [{ kind: '3d', expression: 'x^2+2' }],
      errors: [],
    });
    expect(samplePlot3D(parsed.plots[0] as never).finiteCount).toBe(400);
  });

  it('reports invalid ranges without dropping visible math', () => {
    expect(parseMathPlots('%plot2d x=10..-10\ny=x')).toMatchObject({
      mathSource: 'y=x',
      plots: [],
      errors: ['2D plot x range must look like x=-10..10.'],
    });
  });

  it('samples 2D plots into drawable segments', () => {
    const parsed = parseMathPlots('%plot2d x=0..3.14, samples=10\ny=\\sin(x)');
    const sampled = samplePlot2D(parsed.plots[0] as never);

    expect(sampled.segments.length).toBeGreaterThan(0);
    expect(sampled.segments[0].length).toBe(16);
    expect(sampled.yDomain.max).toBeGreaterThan(0.9);
  });

  it('samples 3D plots into a finite grid', () => {
    const parsed = parseMathPlots('%plot3d z=x^2+y^2, x=-2..2, y=-2..2, samples=20');
    const sampled = samplePlot3D(parsed.plots[0] as never);

    expect(sampled.rows).toHaveLength(20);
    expect(sampled.rows[0]).toHaveLength(20);
    expect(sampled.finiteCount).toBe(400);
    expect(sampled.zDomain.max).toBeGreaterThan(7);
  });

  it('honors a manual y-axis override for 2D plots', () => {
    const parsed = parseMathPlots('%plot2d x=0..3.14, samples=10\ny=\\sin(x)');
    const base = parsed.plots[0] as never as import('./mathPlotSpec').MathPlot2DSpec;
    const sampled = samplePlot2D({ ...base, yDomain: { min: -2, max: 2 } });

    expect(sampled.yDomain).toEqual({ min: -2, max: 2 });
  });

  it('ignores an inverted manual y-axis override and falls back to auto-fit', () => {
    const parsed = parseMathPlots('%plot2d x=0..3.14, samples=10\ny=\\sin(x)');
    const base = parsed.plots[0] as never as import('./mathPlotSpec').MathPlot2DSpec;
    const sampled = samplePlot2D({ ...base, yDomain: { min: 5, max: 5 } });

    // Auto-fit domain, not the degenerate override.
    expect(sampled.yDomain.min).toBeLessThan(sampled.yDomain.max);
    expect(sampled.yDomain).not.toEqual({ min: 5, max: 5 });
  });

  it('honors a manual z-axis override for 3D plots', () => {
    const parsed = parseMathPlots('%plot3d z=x^2+y^2, x=-2..2, y=-2..2, samples=20');
    const base = parsed.plots[0] as never as import('./mathPlotSpec').MathPlot3DSpec;
    const sampled = samplePlot3D({ ...base, zDomain: { min: 0, max: 4 } });

    expect(sampled.zDomain).toEqual({ min: 0, max: 4 });
  });

  it('builds compact default directives for inferred math bodies', () => {
    expect(buildDefaultPlotDirective('2d', 'y=\\sin(x)')).toBe('%plot2d x=-10..10, samples=600');
    expect(buildDefaultPlotDirective('3d', 'z=x^2+y^2')).toBe(
      '%plot3d x=-5..5, y=-5..5, samples=60',
    );
  });
});
