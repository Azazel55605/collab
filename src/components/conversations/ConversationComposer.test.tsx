import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { prefixLines, wrapSelection } from './chatFormat';
import { ConversationComposer } from './ConversationComposer';

it('wraps a selection or inserts a selected placeholder', () => {
  expect(wrapSelection({ text: 'say hi', start: 4, end: 6 }, '**')).toEqual({
    text: 'say **hi**',
    start: 6,
    end: 8,
  });
  expect(wrapSelection({ text: '', start: 0, end: 0 }, '_')).toEqual({
    text: '_text_',
    start: 1,
    end: 5,
  });
});
it('toggles list prefixes across every selected line', () => {
  const numbered = prefixLines({ text: 'a\nb', start: 0, end: 3 }, (i) => `${i + 1}. `);
  expect(numbered.text).toBe('1. a\n2. b');
  expect(
    prefixLines({ ...numbered, start: 0, end: numbered.text.length }, (i) => `${i + 1}. `).text,
  ).toBe('a\nb');
  expect(prefixLines({ text: '1. a', start: 0, end: 4 }, () => '- ').text).toBe('- a');
});
it('sends on Enter normally but keeps writing in the expanded editor until Ctrl+Enter', async () => {
  const submit = vi.fn().mockResolvedValue(true);
  render(
    <ConversationComposer
      placeholder="Message"
      disabled={false}
      sending={false}
      mode={null}
      cancelMode={vi.fn()}
      submit={submit}
    />,
  );
  const field = screen.getByLabelText('Message') as HTMLTextAreaElement;
  fireEvent.change(field, { target: { value: 'hello' } });
  fireEvent.click(screen.getByRole('button', { name: 'Format' }));
  expect(screen.getByRole('toolbar', { name: 'Formatting' })).not.toBeNull();
  fireEvent.keyDown(field, { key: 'Enter' });
  expect(submit).not.toHaveBeenCalled();
  field.setSelectionRange(0, 5);
  fireEvent.keyDown(field, { key: 'b', ctrlKey: true });
  await waitFor(() => expect(field.value).toBe('**hello**'));
  fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });
  await waitFor(() => expect(submit).toHaveBeenCalledWith('**hello**'));
  await waitFor(() => expect(field.value).toBe(''));
});
it('edits in place of the draft and restores the draft afterwards', async () => {
  const props = {
    placeholder: 'Message',
    disabled: false,
    sending: false,
    cancelMode: vi.fn(),
    submit: vi.fn().mockResolvedValue(true),
  };
  const view = render(<ConversationComposer {...props} mode={null} />);
  const field = screen.getByLabelText('Message') as HTMLTextAreaElement;
  fireEvent.change(field, { target: { value: 'my draft' } });
  view.rerender(
    <ConversationComposer {...props} mode={{ kind: 'edit', id: 'm', content: 'old' }} />,
  );
  expect(field.value).toBe('old');
  expect(screen.getByText('Editing message')).not.toBeNull();
  fireEvent.keyDown(field, { key: 'Escape' });
  expect(props.cancelMode).toHaveBeenCalled();
  view.rerender(<ConversationComposer {...props} mode={null} />);
  expect(field.value).toBe('my draft');
});
