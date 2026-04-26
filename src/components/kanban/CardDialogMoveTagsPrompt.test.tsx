import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CardDialogMoveTagsPrompt } from './CardDialogMoveTagsPrompt';

describe('CardDialogMoveTagsPrompt', () => {
  it('renders nothing without a prompt', () => {
    const { container } = render(
      <CardDialogMoveTagsPrompt
        draftTitle="Card"
        prompt={null}
        onClose={vi.fn()}
        onApplyOnce={vi.fn()}
        onAlwaysApply={vi.fn()}
      />,
    );

    expect(container.innerHTML).toBe('');
  });

  it('renders prompt details and dispatches actions', () => {
    const onClose = vi.fn();
    const onApplyOnce = vi.fn();
    const onAlwaysApply = vi.fn();

    render(
      <CardDialogMoveTagsPrompt
        draftTitle="Card"
        prompt={{
          destinationColumnId: 'done',
          destinationColumnTitle: 'Done',
          missingTags: ['done', 'review'],
        }}
        onClose={onClose}
        onApplyOnce={onApplyOnce}
        onAlwaysApply={onAlwaysApply}
      />,
    );

    expect(screen.getByText('Apply column tags?')).toBeTruthy();
    expect(screen.getByText(/was moved to/i).textContent).toContain('Card');
    expect(screen.getByText(/was moved to/i).textContent).toContain('Done');
    expect(screen.getByText('review')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /not now/i }));
    expect(onClose).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /apply once/i }));
    expect(onApplyOnce).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /always apply here/i }));
    expect(onAlwaysApply).toHaveBeenCalled();
  });
});
