import { Input } from '../ui/input';
import { Button } from '../ui/button';
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
  return (
    <div>
      <SectionLabel>Your Identity</SectionLabel>
      <p className="text-xs text-muted-foreground mb-4">
        Shown to collaborators when editing a shared vault.
      </p>

      <div className="space-y-4">
        <OptionRow label="Display name" description="Visible to other users in real time">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-44 h-8 text-sm bg-input/50"
            placeholder="Your name"
          />
        </OptionRow>

        <Separator className="bg-border/40" />

        <OptionRow label="Presence color" description="Your avatar color in the status bar">
          <div
            className="w-7 h-7 rounded-full border-2 border-border/60"
            style={{ backgroundColor: myUserColor }}
          />
        </OptionRow>

        <Separator className="bg-border/40" />

        <div>
          <p className="text-sm font-medium mb-1">User ID</p>
          <p className="text-[11px] text-muted-foreground font-mono bg-muted/40 px-2 py-1.5 rounded-md border border-border/30 break-all">
            {myUserId}
          </p>
        </div>

        <Button
          size="sm"
          onClick={onSave}
          className="mt-2"
        >
          Save Profile
        </Button>
      </div>
    </div>
  );
}
