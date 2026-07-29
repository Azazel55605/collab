import { describe, expect, it } from 'vitest';

import {
  activeFormulaFunction,
  formulaAutocompleteContext,
  insertFormulaReference,
} from './formulaFunctions';

describe('formula IntelliSense helpers', () => {
  it('finds the function token at the caret rather than only at the end', () => {
    expect(formulaAutocompleteContext('=SU+A1', 3)).toEqual({
      query: 'SU',
      start: 1,
      end: 3,
    });
    expect(formulaAutocompleteContext('=SUM(', 5)).toEqual({
      query: '',
      start: 5,
      end: 5,
    });
  });

  it('reports the innermost active function signature', () => {
    expect(activeFormulaFunction('=IF(A1,SUM(B1:B2', 18)?.name).toBe('SUM');
    expect(activeFormulaFunction('=SUM(A1:A2)', 10)?.name).toBe('SUM');
    expect(activeFormulaFunction('=SUM(A1:A2)', 11)).toBeNull();
  });

  it('inserts single cells and ranges at the caret with argument separation', () => {
    expect(insertFormulaReference('=SUM(', 'A1:B4', 5)).toEqual({
      value: '=SUM(A1:B4',
      cursor: 10,
    });
    expect(insertFormulaReference('=SUM(A1', 'C1:C3', 7).value).toBe('=SUM(A1,C1:C3');
  });
});
