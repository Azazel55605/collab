import { useEffect, useState } from 'react';

import { Button } from '../components/ui/button';
import { registerMediaCleanup } from '../lib/mediaLifecycle';

const peaksByRevision = new Map<string, number[]>();
registerMediaCleanup(() => peaksByRevision.clear());

export default function AudioWaveform({
  url,
  size,
  cacheKey,
}: {
  url: string;
  size: number;
  cacheKey: string;
}) {
  const [requested, setRequested] = useState(false);
  const [peaks, setPeaks] = useState<number[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!requested) return;
    const cached = peaksByRevision.get(cacheKey);
    if (cached) {
      setPeaks(cached);
      return;
    }
    const controller = new AbortController();
    void import('./mediaWaveform')
      .then(({ loadWaveform }) => loadWaveform(url, size, controller.signal))
      .then(
        (result) => {
          if (controller.signal.aborted) return;
          if (peaksByRevision.size >= 16)
            peaksByRevision.delete(peaksByRevision.keys().next().value!);
          peaksByRevision.set(cacheKey, result);
          setPeaks(result);
        },
        (reason: unknown) => {
          if (!controller.signal.aborted) setError(String(reason));
        },
      );
    return () => controller.abort();
  }, [cacheKey, requested, size, url]);

  if (error)
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {error}
      </p>
    );
  if (!requested)
    return (
      <Button variant="ghost" size="sm" onClick={() => setRequested(true)}>
        Show waveform
      </Button>
    );
  if (!peaks.length)
    return (
      <p role="status" className="text-xs text-muted-foreground">
        Generating waveform…
      </p>
    );
  return (
    <div role="img" aria-label="Audio waveform" className="flex h-10 w-full items-center gap-px">
      {peaks.map((peak, index) => (
        <span
          key={index}
          className="min-w-0 flex-1 rounded-sm bg-primary/60"
          style={{ height: `${Math.max(5, peak * 100)}%` }}
        />
      ))}
    </div>
  );
}
