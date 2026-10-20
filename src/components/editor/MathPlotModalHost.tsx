import { useEffect, useState } from 'react';

import { DeferredModalStatus } from '../layout/DeferredModalStatus';
import { deferredView } from '../layout/deferredView';

import type { MathPlotSpec } from './mathPlotSpec';

type Listener = (spec: MathPlotSpec | null) => void;
const listeners = new Set<Listener>();
export function openMathPlotModal(spec: MathPlotSpec) {
  for (const listener of listeners) listener(spec);
}
function close() {
  for (const listener of listeners) listener(null);
}
const Modal = deferredView(
  async () => ({ default: (await import('./MathPlotModal')).MathPlotModal }),
  {
    loading: <DeferredModalStatus title="Math plot" close={close} />,
    error: <DeferredModalStatus title="Math plot" close={close} failed />,
  },
);

/** The small event bus stays mounted; plot controls/renderers load only on open. */
export function MathPlotModalHost() {
  const [spec, setSpec] = useState<MathPlotSpec | null>(null);
  useEffect(() => {
    listeners.add(setSpec);
    return () => {
      listeners.delete(setSpec);
    };
  }, []);
  return spec ? (
    <Modal
      spec={spec}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    />
  ) : null;
}
