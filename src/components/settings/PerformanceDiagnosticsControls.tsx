import { useState } from 'react';

import { getPerformanceDiagnostics } from '../../lib/performanceDiagnostics';
import { Button } from '../ui/button';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '../ui/field';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';

const scenarios = ['cold-start', 'warm-start', 'idle', 'interaction', 'open-close-soak'];
export default function PerformanceDiagnosticsControls() {
  const api = getPerformanceDiagnostics();
  const [scenario, setScenario] = useState('interaction');
  const [status, setStatus] = useState(() => api?.status());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!api) return null;
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setStatus(api!.status());
      setBusy(false);
    }
  }
  return (
    <section className="mt-4 flex flex-col gap-3" aria-label="Performance diagnostics">
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="performance-scenario">Performance capture</FieldLabel>
          <FieldDescription>
            Record a scenario, finish it after testing, then save its report. Available in
            diagnostic builds.
          </FieldDescription>
          <Select value={scenario} onValueChange={setScenario} disabled={busy || !!status?.active}>
            <SelectTrigger id="performance-scenario" size="sm" aria-label="Performance scenario">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {scenarios.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name.replace(/-/g, ' ')}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      </FieldGroup>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !!status?.active}
          onClick={() => void run(() => api.start(scenario))}
        >
          Start capture
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !status?.active}
          onClick={() => void run(() => api.finish())}
        >
          Finish capture
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !!status?.active || !status?.scenarios}
          onClick={() => void run(() => api.export())}
        >
          Save performance report
        </Button>
      </div>
      <p role="status" className="text-xs text-muted-foreground">
        {status?.active
          ? `Recording ${status.active.replace(/-/g, ' ')}. Close settings and perform the scenario, then return here to finish.`
          : `${status?.scenarios ?? 0} ${status?.scenarios === 1 ? 'scenario' : 'scenarios'} recorded. ${status?.interactions ?? 0} interaction samples in the latest capture.`}
      </p>
      {error && <FieldError>{error}</FieldError>}
    </section>
  );
}
