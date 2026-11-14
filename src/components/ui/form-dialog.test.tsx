import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FormDialog, FormField, PromptDialog } from './form-dialog';
import { Input } from './input';

describe('FormDialog', () => {
  it('submits on Enter and shows a form error', () => {
    const onSubmit = vi.fn();
    render(
      <FormDialog
        open
        onOpenChange={() => {}}
        title="New calendar"
        submitLabel="Create calendar"
        error="Name is taken"
        onSubmit={onSubmit}
      >
        <FormField label="Name" htmlFor="name">
          <Input id="name" defaultValue="Team" />
        </FormField>
      </FormDialog>,
    );
    fireEvent.submit(screen.getByLabelText('Name').closest('form')!);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert').textContent).toBe('Name is taken');
  });
});

describe('PromptDialog', () => {
  it('trims the value, validates it, and shows a thrown error inline', async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error('A file with that name exists'))
      .mockResolvedValueOnce(undefined);
    render(
      <PromptDialog
        open
        onOpenChange={() => {}}
        title="Rename"
        label="Name"
        initialValue="Plan.md"
        submitLabel="Rename"
        validate={(value) => (value.includes('/') ? 'Names cannot contain /' : null)}
        onSubmit={onSubmit}
      />,
    );
    const field = screen.getByLabelText('Name');
    fireEvent.change(field, { target: { value: 'a/b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(screen.getByRole('alert').textContent).toBe('Names cannot contain /');
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: '  Roadmap.md  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    expect(await screen.findByText('A file with that name exists')).toBeTruthy();
    expect(onSubmit).toHaveBeenCalledWith('Roadmap.md');
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
  });
});
