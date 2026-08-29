import { useCollabIdentity } from '../../lib/collabIdentity';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Separator } from '../ui/separator';

import { OptionRow, SectionLabel } from './settingsControls';

type Props = {
  name: string;
  setName: (value: string) => void;
  myUserColor: string;
  myUserId: string;
  onSave: () => void;
};

export default function SettingsProfileSection({
  name,
  setName,
  myUserColor,
  myUserId,
  onSave,
}: Props) {
  const identity = useCollabIdentity();
  const serverManaged = identity.source === 'server';

  return (
    <div>
      <SectionLabel>Your Identity</SectionLabel>
      <p className="text-xs text-muted-foreground mb-4">
        {serverManaged
          ? 'In this hosted vault your identity is managed by the server and cannot be edited here.'
          : 'Shown to collaborators when editing a shared vault.'}
      </p>

      <div className="space-y-4">
        <OptionRow
          label="Display name"
          description={
            serverManaged ? 'Provided by the hosted server' : 'Visible to other users in real time'
          }
        >
          {serverManaged ? (
            <span className="text-sm font-medium">{identity.userName}</span>
          ) : (
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-44 h-8 text-sm bg-input/50"
              placeholder="Your name"
            />
          )}
        </OptionRow>

        <Separator className="bg-border/40" />

        <OptionRow label="Presence color" description="Your avatar color in the status bar">
          <div
            className="w-7 h-7 rounded-full border-2 border-border/60"
            style={{ backgroundColor: serverManaged ? identity.userColor : myUserColor }}
          />
        </OptionRow>

        <Separator className="bg-border/40" />

        <div>
          <p className="text-sm font-medium mb-1">User ID</p>
          <p className="text-[11px] text-muted-foreground font-mono bg-muted/40 px-2 py-1.5 rounded-md border border-border/30 break-all">
            {serverManaged ? identity.userId : myUserId}
          </p>
        </div>

        {!serverManaged && (
          <Button size="sm" onClick={onSave} className="mt-2">
            Save Profile
          </Button>
        )}
      </div>
    </div>
  );
}
