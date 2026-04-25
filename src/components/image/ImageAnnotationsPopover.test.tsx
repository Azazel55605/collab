import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ImageAnnotationsPopover } from './ImageAnnotationsPopover';

describe('ImageAnnotationsPopover', () => {
  it('shows the empty state when there are no annotations', () => {
    render(
      <ImageAnnotationsPopover
        open
        onOpenChange={vi.fn()}
        items={[]}
        selectedItemId={null}
        onSelectItem={vi.fn()}
        onDeleteItem={vi.fn()}
      />,
    );

    expect(screen.getByText(/no additive annotations yet/i)).toBeTruthy();
  });

  it('selects and deletes annotation entries', () => {
    const onOpenChange = vi.fn();
    const onSelectItem = vi.fn();
    const onDeleteItem = vi.fn();

    render(
      <ImageAnnotationsPopover
        open
        onOpenChange={onOpenChange}
        items={[
          { id: 'text-1', type: 'text', x: 0, y: 0, width: 0.2, height: 0.1, text: 'Alpha', color: '#fff', fontSize: 18 },
          { id: 'arrow-1', type: 'arrow', start: { x: 0, y: 0 }, end: { x: 1, y: 1 }, color: '#fff', strokeWidth: 4, lineStyle: 'solid' },
        ]}
        selectedItemId="arrow-1"
        onSelectItem={onSelectItem}
        onDeleteItem={onDeleteItem}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /text: alpha/i }));
    expect(onSelectItem).toHaveBeenCalledWith('text-1');
    expect(onOpenChange).toHaveBeenCalledWith(false);

    fireEvent.click(screen.getAllByRole('button').find((button) => button.textContent === '') ?? screen.getAllByRole('button')[2]);
    expect(onDeleteItem).toHaveBeenCalled();
  });
});
