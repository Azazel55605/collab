import { useState } from 'react';

import type { DatabaseConnection, DatabaseNetworkEngine } from '../../types/database';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '../ui/field';
import { Input } from '../ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

export default function ConnectionForm({
  initial,
  durable,
  busy,
  onClose,
  onSave,
}: {
  initial: DatabaseConnection | null;
  durable: boolean;
  busy: boolean;
  onClose: () => void;
  onSave: (config: DatabaseConnection, password?: string) => void;
}) {
  const [config, setConfig] = useState<DatabaseConnection>(
    initial ?? {
      id: '',
      engine: 'sql_server',
      label: '',
      environment: 'Development',
      host: '',
      port: 1433,
      database: 'master',
      username: '',
      certificate_hostname: null,
      remember_password: false,
    },
  );
  const maria = config.engine === 'maria_db';
  const [password, setPassword] = useState('');
  const update = <K extends keyof DatabaseConnection>(key: K, value: DatabaseConnection[K]) =>
    setConfig((previous) => ({ ...previous, [key]: value }));
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{initial ? 'Edit connection' : 'New database connection'}</DialogTitle>
          <DialogDescription>
            Connections belong to your local profile. TLS encryption and certificate verification
            are required. {initial && 'Saving changes closes this connection’s current sessions.'}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSave(config, password || undefined);
            setPassword('');
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="db-engine">Database engine</FieldLabel>
              <Select
                value={config.engine ?? 'sql_server'}
                disabled={busy || !!initial}
                onValueChange={(engine: DatabaseNetworkEngine) =>
                  setConfig((previous) => ({
                    ...previous,
                    engine,
                    port: engine === 'maria_db' ? 3306 : 1433,
                    database: engine === 'maria_db' ? '' : 'master',
                    certificate_hostname: null,
                  }))
                }
              >
                <SelectTrigger id="db-engine">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sql_server">SQL Server</SelectItem>
                  <SelectItem value="maria_db">MariaDB</SelectItem>
                </SelectContent>
              </Select>
              {maria && (
                <FieldDescription>
                  Use the hostname on the server certificate and a CA trusted by your system.
                </FieldDescription>
              )}
            </Field>
            {(['label', 'environment', 'host', 'database', 'username'] as const).map((key) => (
              <Field key={key}>
                <FieldLabel htmlFor={`db-${key}`}>
                  {
                    {
                      label: 'Connection name',
                      environment: 'Environment label',
                      host: 'Hostname or IP address',
                      database: 'Initial database',
                      username: 'SQL username',
                    }[key]
                  }
                </FieldLabel>
                <Input
                  id={`db-${key}`}
                  autoComplete="off"
                  required={key !== 'environment'}
                  maxLength={512}
                  value={config[key]}
                  disabled={busy}
                  onChange={(event) => update(key, event.target.value)}
                />
              </Field>
            ))}
            <Field>
              <FieldLabel htmlFor="db-port">TCP port</FieldLabel>
              <Input
                id="db-port"
                inputMode="numeric"
                type="number"
                min={1}
                max={65535}
                required
                value={config.port}
                disabled={busy}
                onChange={(event) => update('port', Number(event.target.value))}
              />
            </Field>
            {!maria && (
              <Field>
                <FieldLabel htmlFor="db-certificate">Certificate hostname (optional)</FieldLabel>
                <Input
                  id="db-certificate"
                  value={config.certificate_hostname ?? ''}
                  maxLength={253}
                  disabled={busy}
                  onChange={(event) => update('certificate_hostname', event.target.value || null)}
                />
                <FieldDescription>
                  Leave blank to verify the server hostname above. Use a certificate name only when
                  connecting through an address alias.
                </FieldDescription>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="db-password">SQL password</FieldLabel>
              <Input
                id="db-password"
                type="password"
                autoComplete="new-password"
                maxLength={4096}
                value={password}
                disabled={busy}
                onChange={(event) => setPassword(event.target.value)}
              />
              <FieldDescription>
                {initial?.remember_password
                  ? 'Leave blank to keep the stored password.'
                  : 'For session-only storage, enter your password when connecting.'}
              </FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <Checkbox
                id="db-remember"
                checked={config.remember_password}
                disabled={busy || (!durable && !config.remember_password)}
                onCheckedChange={(value) => update('remember_password', value === true)}
              />
              <FieldLabel htmlFor="db-remember">
                Remember password in the operating system credential store
              </FieldLabel>
            </Field>
            {!durable && (
              <FieldDescription>
                This package supports session-only passwords. No password is saved to disk.
              </FieldDescription>
            )}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? 'Saving…' : 'Save connection'}
              </Button>
            </div>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
