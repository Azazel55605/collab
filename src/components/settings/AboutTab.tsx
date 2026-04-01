import { useEffect, useState } from 'react';
import { getAppVersion } from '../../lib/tauri';
import { useUpdateStore } from '../../store/updateStore';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/utils';
import { RefreshCw, Download, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024)        return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export default function AboutTab() {
  const [appVersion, setAppVersion] = useState<string>('…');
  const {
    status, updateInfo, downloadProgress, downloadedBytes, totalBytes, downloadSpeed,
    error, lastChecked, checkForUpdate, startDownload,
  } = useUpdateStore();

  useEffect(() => {
    getAppVersion().then(setAppVersion).catch(() => setAppVersion('?'));
  }, []);

  const isWorking = status === 'checking' || status === 'downloading' || status === 'installing';

  function renderStatus() {
    switch (status) {
      case 'idle':
        return null;
      case 'checking':
        return (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" />
            Checking for updates…
          </div>
        );
      case 'up_to_date':
        return (
          <div className="flex items-center gap-2 text-sm text-green-500">
            <CheckCircle size={14} />
            You're on the latest version.
          </div>
        );
      case 'available':
        return (
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-sm font-medium text-primary">
              <Download size={14} />
              v{updateInfo?.version} is available
            </div>
            {updateInfo?.notes && (
              <p className="text-[12px] text-muted-foreground leading-relaxed pl-5">
                {updateInfo.notes}
              </p>
            )}
          </div>
        );
      case 'downloading': {
        const pct   = downloadProgress ?? 0;
        const speed = downloadSpeed != null && downloadSpeed > 0 ? downloadSpeed : null;
        return (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 size={14} className="animate-spin shrink-0" />
                Downloading update…
              </div>
              {speed !== null && (
                <span className="text-xs text-muted-foreground/70 tabular-nums shrink-0">
                  {fmtBytes(speed)}/s
                </span>
              )}
            </div>
            <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-200"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[11px] text-muted-foreground tabular-nums">
              <span>
                {downloadedBytes != null ? fmtBytes(downloadedBytes) : '0 B'}
                {totalBytes != null ? ` / ${fmtBytes(totalBytes)}` : ''}
              </span>
              <span>{pct}%</span>
            </div>
          </div>
        );
      }
      case 'installing':
        return (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" />
            Installing… the app will restart shortly.
          </div>
        );
      case 'error':
        return (
          <div className="flex items-start gap-2 text-sm text-destructive">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span>
              {error?.includes('os error') || error?.includes('network') || error?.includes('connect')
                ? 'Could not reach the update server. Check your connection.'
                : error?.includes('signature') || error?.includes('verify')
                ? 'Update verification failed. The download could not be trusted.'
                : (error ?? 'An unexpected error occurred.')}
            </span>
          </div>
        );
    }
  }

  return (
    <div className="space-y-5">
      {/* Version info */}
      <div>
        <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-widest mb-3">
          Version
        </p>
        <div className="flex items-center gap-3">
          <Badge variant="secondary" className="text-[11px] font-mono">
            collab v{appVersion}
          </Badge>
        </div>
      </div>

      {/* Status */}
      <div className="min-h-[40px]">{renderStatus()}</div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={isWorking}
          onClick={checkForUpdate}
          className={cn('h-7 text-xs gap-1.5', isWorking && 'opacity-50')}
        >
          <RefreshCw size={12} className={cn(status === 'checking' && 'animate-spin')} />
          Check for updates
        </Button>

        {status === 'available' && (
          <Button size="sm" onClick={startDownload} className="h-7 text-xs gap-1.5">
            <Download size={12} />
            Download &amp; Install
          </Button>
        )}

        {status === 'error' && (
          <Button size="sm" variant="outline" onClick={checkForUpdate} className="h-7 text-xs">
            Try again
          </Button>
        )}
      </div>

      {/* Last checked */}
      {lastChecked && (
        <p className="text-[11px] text-muted-foreground">
          Last checked {formatDistanceToNow(lastChecked, { addSuffix: true })}
        </p>
      )}
    </div>
  );
}
