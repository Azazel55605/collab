import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { OptionRow } from './settingsControls';

describe('OptionRow', () => {
  it('keeps wide option groups below their label when stacked', () => {
    const { container } = render(
      <OptionRow label="Pen" description="Initial brush" stacked>
        <div>Wide choices</div>
      </OptionRow>,
    );

    expect(container.firstElementChild?.className).toContain('flex-col');
    expect(screen.getByText('Wide choices').parentElement?.className).toContain('w-full');
  });
});
