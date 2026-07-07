import { cn } from '../../lib/utils';
import { Separator } from '../ui/separator';
import { OptionRow, SectionLabel, ToggleSwitch } from './settingsControls';

type Props = {
  restorePreviousSession: boolean;
  setRestorePreviousSession: (value: boolean) => void;
  webPreviewsEnabled: boolean;
  setWebPreviewsEnabled: (value: boolean) => void;
  hoverWebLinkPreviewsEnabled: boolean;
  setHoverWebLinkPreviewsEnabled: (value: boolean) => void;
  backgroundWebPreviewPrefetchEnabled: boolean;
  setBackgroundWebPreviewPrefetchEnabled: (value: boolean) => void;
  fileTreeHoverPreviewsEnabled: boolean;
  setFileTreeHoverPreviewsEnabled: (value: boolean) => void;
  confirmDelete: boolean;
  setConfirmDelete: (value: boolean) => void;
  liveCollabDebug: boolean;
  setLiveCollabDebug: (value: boolean) => void;
};

export default function SettingsGeneralSection({
  restorePreviousSession,
  setRestorePreviousSession,
  webPreviewsEnabled,
  setWebPreviewsEnabled,
  hoverWebLinkPreviewsEnabled,
  setHoverWebLinkPreviewsEnabled,
  backgroundWebPreviewPrefetchEnabled,
  setBackgroundWebPreviewPrefetchEnabled,
  fileTreeHoverPreviewsEnabled,
  setFileTreeHoverPreviewsEnabled,
  confirmDelete,
  setConfirmDelete,
  liveCollabDebug,
  setLiveCollabDebug,
}: Props) {
  return (
    <div>
      <SectionLabel>Startup</SectionLabel>
      <OptionRow
        label="Restore previous session"
        description="Reopen the last vault and previously open files when launching the app"
      >
        <ToggleSwitch
          checked={restorePreviousSession}
          onToggle={() => setRestorePreviousSession(!restorePreviousSession)}
        />
      </OptionRow>

      <Separator className="bg-border/40 my-4" />

      <SectionLabel>Previews</SectionLabel>
      <OptionRow
        label="Hover previews in file tree"
        description="Show a lightweight image or PDF preview beside supported files when hovering them in the file tree"
      >
        <ToggleSwitch
          checked={fileTreeHoverPreviewsEnabled}
          onToggle={() => setFileTreeHoverPreviewsEnabled(!fileTreeHoverPreviewsEnabled)}
          animated
        />
      </OptionRow>

      <div className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
        Web previews
      </div>
      <OptionRow
        label="Enable web previews"
        description="Master switch for loading website previews anywhere in the app, including canvas web cards"
      >
        <ToggleSwitch
          checked={webPreviewsEnabled}
          onToggle={() => setWebPreviewsEnabled(!webPreviewsEnabled)}
          animated
        />
      </OptionRow>

      <OptionRow
        label="Hover previews for links"
        description="Show a small website preview below external links when hovering over them"
        disabled={!webPreviewsEnabled}
      >
        <ToggleSwitch
          checked={hoverWebLinkPreviewsEnabled}
          onToggle={() => setHoverWebLinkPreviewsEnabled(!hoverWebLinkPreviewsEnabled)}
          disabled={!webPreviewsEnabled}
          animated
        />
      </OptionRow>

      <OptionRow
        label="Background prefetch for open documents"
        description="Warm website previews in the background for visible or open documents instead of the whole vault"
        disabled={!webPreviewsEnabled || !hoverWebLinkPreviewsEnabled}
      >
        <ToggleSwitch
          checked={backgroundWebPreviewPrefetchEnabled}
          onToggle={() => setBackgroundWebPreviewPrefetchEnabled(!backgroundWebPreviewPrefetchEnabled)}
          disabled={!webPreviewsEnabled || !hoverWebLinkPreviewsEnabled}
          animated
        />
      </OptionRow>

      <Separator className="bg-border/40 my-4" />

      <SectionLabel>File Operations</SectionLabel>
      <OptionRow
        label="Confirm before deleting"
        description="Show a confirmation dialog before permanently deleting notes or folders"
      >
        <ToggleSwitch
          checked={confirmDelete}
          onToggle={() => setConfirmDelete(!confirmDelete)}
        />
      </OptionRow>

      <Separator className="bg-border/40 my-4" />

      <SectionLabel>Diagnostics</SectionLabel>
      <OptionRow
        label="Live collaboration debug"
        description="Trace live co-editing (connect, sync, and awareness frames) in an on-screen panel you can copy from — useful for diagnosing sync problems without devtools"
      >
        <ToggleSwitch
          checked={liveCollabDebug}
          onToggle={() => setLiveCollabDebug(!liveCollabDebug)}
          animated
        />
      </OptionRow>

      <div className={cn('mt-3 rounded-xl border border-border/35 bg-card/55 p-3 text-xs text-muted-foreground shadow-sm')}>
        {webPreviewsEnabled
          ? 'Web previews are enabled globally. Hover previews and background prefetch can be tuned independently.'
          : 'Web previews are disabled globally, so canvas web cards and link hover previews will not fetch metadata.'}
      </div>
    </div>
  );
}
