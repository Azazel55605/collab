import { expect, it } from 'vitest';

import type { ResultSet } from './queryStore';
import { exportResults, valueText } from './values';

it('exports loaded exact typed data and protects CSV formulas in headers and text cells', () => {
  const result: ResultSet = {
    columns: [
      {
        name: '=header()',
        engine_type: 'nvarchar',
        nullable: true,
        generated: false,
        version_token: false,
        precision: null,
        scale: null,
      },
    ],
    rows: [
      [{ kind: 'text', value: '=HYPERLINK("x")' }],
      [{ kind: 'integer', decimal: '-9223372036854775808' }],
      [{ kind: 'null' }],
      [{ kind: 'text', value: '' }],
      [
        {
          kind: 'truncated',
          engine_type: 'nvarchar(max)',
          preview: 'prefix',
          original_bytes: 2000000,
        },
      ],
    ],
  };
  const csv = exportResults(result, false);
  expect(csv).toContain('"\'=header()"');
  expect(csv).toContain('"\'=HYPERLINK(""x"")"');
  expect(csv).toContain('"-9223372036854775808"');
  expect(csv).toContain('[truncated]');
  expect(JSON.parse(exportResults(result, true))).toEqual(result);
  expect(valueText({ kind: 'null' })).not.toBe(valueText({ kind: 'text', value: '' }));
});
