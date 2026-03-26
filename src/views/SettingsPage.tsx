import { useState } from 'react';
import { useCollabStore } from '../store/collabStore';
import { useUiStore } from '../store/uiStore';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';
import { toast } from 'sonner';

export default function SettingsPage() {
  const { myUserName, myUserColor, setMyProfile, myUserId } = useCollabStore();
  const { theme, setTheme } = useUiStore();
  const [name, setName] = useState(myUserName);

  const handleSave = () => {
    setMyProfile(myUserId, name, myUserColor);
    toast.success('Settings saved');
  };

  return (
    <div className="flex-1 overflow-y-auto p-8">
      <div className="max-w-lg">
        <h1 className="text-2xl font-bold mb-6">Settings</h1>

        <section className="mb-8">
          <h2 className="text-lg font-semibold mb-4">Profile</h2>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Display Name</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="max-w-xs"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">User ID</label>
              <p className="text-sm text-muted-foreground font-mono">{myUserId}</p>
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Presence Color</label>
              <div
                className="w-8 h-8 rounded-full border border-border"
                style={{ backgroundColor: myUserColor }}
              />
            </div>
            <Button onClick={handleSave}>Save Profile</Button>
          </div>
        </section>

        <section className="mb-8">
          <h2 className="text-lg font-semibold mb-4">Appearance</h2>
          <div className="flex gap-2">
            <Button
              variant={theme === 'dark' ? 'default' : 'outline'}
              onClick={() => setTheme('dark')}
            >
              Dark
            </Button>
            <Button
              variant={theme === 'light' ? 'default' : 'outline'}
              onClick={() => setTheme('light')}
            >
              Light
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}
