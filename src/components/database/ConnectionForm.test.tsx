import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import ConnectionForm from './ConnectionForm';

it('submits the password separately from metadata and clears its input', () => {
  const save = vi.fn();
  render(<ConnectionForm initial={null} durable busy={false} onClose={vi.fn()} onSave={save} />);
  fireEvent.change(screen.getByLabelText('Connection name'), { target: { value: 'Fixture' } });
  fireEvent.change(screen.getByLabelText('Hostname or IP address'), {
    target: { value: 'localhost' },
  });
  fireEvent.change(screen.getByLabelText('SQL username'), { target: { value: 'reader' } });
  fireEvent.change(screen.getByLabelText('SQL password'), {
    target: { value: 'synthetic-password' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
  expect(save).toHaveBeenCalledTimes(1);
  const [config, password] = save.mock.calls[0];
  expect(password).toBe('synthetic-password');
  expect(JSON.stringify(config)).not.toContain('synthetic-password');
  expect(config.remember_password).toBe(false);
  expect(config.id).toBe('');
  expect((screen.getByLabelText('SQL password') as HTMLInputElement).value).toBe('');
});
it('disables opt-in durable storage when the native package only supports session passwords', () => {
  render(
    <ConnectionForm
      initial={null}
      durable={false}
      busy={false}
      onClose={vi.fn()}
      onSave={vi.fn()}
    />,
  );
  expect((screen.getByRole('checkbox') as HTMLButtonElement).disabled).toBe(true);
  expect(
    screen.getByText('This package supports session-only passwords. No password is saved to disk.'),
  ).toBeTruthy();
});
