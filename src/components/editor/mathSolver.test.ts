import { describe, expect, it } from 'vitest';

import { analyzeMathInput, solveMathInput } from './mathSolver';

describe('solveMathInput', () => {
  it('analyzes ambiguous multi-variable equations', () => {
    expect(analyzeMathInput('a*x+b=0')).toEqual({
      kind: 'equation',
      variables: ['a', 'b', 'x'],
      defaultVariable: null,
    });
  });

  it('evaluates arithmetic expressions', () => {
    expect(solveMathInput('2+2')).toEqual({ kind: 'expression', latex: '4' });
  });

  it('evaluates simple LaTeX expressions', () => {
    expect(solveMathInput('\\frac{1}{2}+\\frac{1}{3}')).toEqual({
      kind: 'expression',
      latex: '\\frac{5}{6}',
    });
  });

  it('approximates simple LaTeX expressions', () => {
    expect(solveMathInput('\\frac{1}{2}', 'approximate')).toEqual({
      kind: 'expression',
      latex: '0.5',
    });
  });

  it('solves a linear equation for x', () => {
    expect(solveMathInput('x+1=3')).toEqual({
      kind: 'equation',
      variable: 'x',
      latex: 'x = 2',
    });
  });

  it('solves a multi-variable equation for a selected variable', () => {
    expect(solveMathInput('a*x+b=0', 'exact', 'x')).toEqual({
      kind: 'equation',
      variable: 'x',
      latex: 'x = -b \\cdot \\frac{1}{a}',
    });
  });

  it('formats multiple equation solutions as a set', () => {
    expect(solveMathInput('x^2-4=0')).toEqual({
      kind: 'equation',
      variable: 'x',
      latex: 'x \\in \\left\\{2, -2\\right\\}',
    });
  });

  it('approximates equation solutions', () => {
    expect(solveMathInput('x^2-2=0', 'approximate')).toEqual({
      kind: 'equation',
      variable: 'x',
      latex: 'x \\approx \\left\\{1.41421356237, -1.41421356237\\right\\}',
    });
  });
  it('finds equation variables on both sides without duplicates', () => {
    expect(analyzeMathInput('x+a=x+b')).toEqual({
      kind: 'equation',
      variables: ['a', 'b', 'x'],
      defaultVariable: null,
    });
  });

  it('rejects structured input instead of treating it as a scalar', () => {
    expect(() => solveMathInput('[1,2]')).toThrow('Only scalar');
  });

  it('does not display an empty solution set as a solution', () => {
    expect(solveMathInput('1/x=0', 'exact', 'x')).toBeNull();
  });
});
