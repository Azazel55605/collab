import { useState } from 'react';

import { Database } from 'lucide-react';

import type { DatabaseConnection, DatabaseNetworkEngine } from '../../types/database';
import { Checkbox } from '../ui/checkbox';
import { FormDialog, FormField, FormRow } from '../ui/form-dialog';
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
      allow_untrusted_certificate: false,
      remember_password: false,
    },
  );
  const skipsVerification = config.allow_untrusted_certificate === true;
  const enablingException = skipsVerification && !initial?.allow_untrusted_certificate;
  const maria = config.engine === 'maria_db';
  const [password, setPassword] = useState('');
  const update = <K extends keyof DatabaseConnection>(key: K, value: DatabaseConnection[K]) =>
    setConfig((previous) => ({
      ...previous,
      [key]: value,
      ...((key === 'host' || key === 'port') && previous[key] !== value
        ? { allow_untrusted_certificate: false }
        : {}),
    }));
  const field = (
    key: 'label' | 'environment' | 'host' | 'database' | 'username',
    label: string,
  ) => (
    <FormField label={label} htmlFor={`db-${key}`}>
      <Input
        id={`db-${key}`}
        autoComplete="off"
        maxLength={512}
        value={config[key]}
        disabled={busy}
        onChange={(event) => update(key, event.target.value)}
      />
    </FormField>
  );
  const complete = Boolean(
    config.label.trim() && config.host.trim() && config.username.trim() && config.port > 0,
  );
  return (
    <FormDialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      className="max-h-[90vh] sm:max-w-[600px]"
      icon={<Database />}
      title={initial ? 'Edit connection' : 'New database connection'}
      description={
        <>
          Connections belong to your local profile. Network connections require TLS encryption.{' '}
          {initial && 'Saving changes closes this connection’s current sessions.'}
        </>
      }
      submitLabel="Save connection"
      submitDisabled={!complete}
      busy={busy}
      onSubmit={() => {
        onSave(config, password || undefined);
        setPassword('');
      }}
    >
      <FormRow>
        {field('label', 'Connection name')}
        {field('environment', 'Environment label')}
      </FormRow>
      <FormField
        label="Database engine"
        htmlFor="db-engine"
        hint={
          maria
            ? 'Use the hostname on the server certificate and a CA trusted by your system.'
            : undefined
        }
      >
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
              allow_untrusted_certificate: false,
            }))
          }
        >
          <SelectTrigger id="db-engine" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="sql_server">SQL Server</SelectItem>
            <SelectItem value="maria_db">MariaDB</SelectItem>
          </SelectContent>
        </Select>
      </FormField>
      <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
        {field('host', 'Hostname or IP address')}
        <FormField label="TCP port" htmlFor="db-port">
          <Input
            id="db-port"
            inputMode="numeric"
            type="number"
            min={1}
            max={65535}
            value={config.port}
            disabled={busy}
            onChange={(event) => update('port', Number(event.target.value))}
          />
        </FormField>
      </div>
      {!maria && (
        <FormField
          label="Certificate hostname (optional)"
          htmlFor="db-certificate"
          hint={
            skipsVerification
              ? 'Certificate hostname checks are skipped for this connection.'
              : 'Leave blank to verify the hostname above. Use a certificate name only when connecting through an address alias.'
          }
        >
          <Input
            id="db-certificate"
            value={config.certificate_hostname ?? ''}
            maxLength={253}
            disabled={busy || skipsVerification}
            onChange={(event) => update('certificate_hostname', event.target.value || null)}
          />
        </FormField>
      )}
      {!maria && (
        <label htmlFor="db-tls-exception" className="flex items-start gap-2 text-[13px]">
          <Checkbox
            id="db-tls-exception"
            className="mt-0.5"
            checked={skipsVerification}
            disabled={busy}
            aria-describedby="db-tls-exception-hint"
            onCheckedChange={(value) => update('allow_untrusted_certificate', value === true)}
          />
          <span>
            Allow untrusted TLS certificates
            <span id="db-tls-exception-hint" className="block text-xs text-muted-foreground">
              Traffic stays encrypted, but Collab cannot verify the server’s identity. Only enable
              this for a server and network you trust.
            </span>
          </span>
        </label>
      )}
      <FormRow>
        {field('database', 'Initial database')}
        {field('username', 'SQL username')}
      </FormRow>
      <FormField
        label="SQL password"
        htmlFor="db-password"
        hint={
          initial?.remember_password && config.remember_password && enablingException
            ? 'Re-enter the stored password to enable this certificate exception.'
            : initial?.remember_password
              ? 'Leave blank to keep the stored password.'
              : 'For session-only storage, enter your password when connecting.'
        }
      >
        <Input
          id="db-password"
          type="password"
          autoComplete="new-password"
          maxLength={4096}
          value={password}
          disabled={busy}
          onChange={(event) => setPassword(event.target.value)}
        />
      </FormField>
      <label htmlFor="db-remember" className="flex items-start gap-2 text-[13px]">
        <Checkbox
          id="db-remember"
          className="mt-0.5"
          checked={config.remember_password}
          disabled={busy || (!durable && !config.remember_password)}
          onCheckedChange={(value) => update('remember_password', value === true)}
        />
        Remember password in the operating system credential store
      </label>
      {!durable && (
        <p className="text-xs text-muted-foreground">
          This package supports session-only passwords. No password is saved to disk.
        </p>
      )}
    </FormDialog>
  );
}
