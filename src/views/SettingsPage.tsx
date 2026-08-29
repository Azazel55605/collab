import { useState } from 'react';

import { toast } from 'sonner';

import SettingsOcrSection from '../components/settings/SettingsOcrSection';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { useCollabIdentity } from '../lib/collabIdentity';
import { cn } from '../lib/utils';
import { useCollabStore } from '../store/collabStore';
import { ANIMATION_SPEED_OPTIONS, type AnimationSpeed, useUiStore } from '../store/uiStore';

export default function SettingsPage() {
  const { myUserName, myUserColor, setMyProfile, myUserId } = useCollabStore();
  const {
    theme,
    setTheme,
    animationsEnabled,
    setAnimationsEnabled,
    animationSpeed,
    setAnimationSpeed,
    canvasWebCardDefaultMode,
    setCanvasWebCardDefaultMode,
    canvasWebCardAutoLoad,
    setCanvasWebCardAutoLoad,
    ocrLanguage,
    setOcrLanguage,
    ocrModelSource,
    setOcrModelSource,
    ocrRenderScale,
    setOcrRenderScale,
    ocrPreprocessingMode,
    setOcrPreprocessingMode,
  } = useUiStore();
  const identity = useCollabIdentity();
  const serverManaged = identity.source === 'server';
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
          {serverManaged && (
            <p className="text-sm text-muted-foreground mb-4">
              In this hosted vault your identity is managed by the server and cannot be edited here.
            </p>
          )}
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block">Display Name</label>
              {serverManaged ? (
                <p className="text-sm">{identity.userName}</p>
              ) : (
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="max-w-xs"
                />
              )}
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">User ID</label>
              <p className="text-sm text-muted-foreground font-mono">
                {serverManaged ? identity.userId : myUserId}
              </p>
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Presence Color</label>
              <div
                className="w-8 h-8 rounded-full border border-border"
                style={{ backgroundColor: serverManaged ? identity.userColor : myUserColor }}
              />
            </div>
            {!serverManaged && <Button onClick={handleSave}>Save Profile</Button>}
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

        <section className="mb-8">
          <h2 className="text-lg font-semibold mb-4">Motion</h2>
          <div className="space-y-4 max-w-md">
            <button
              onClick={() => setAnimationsEnabled(!animationsEnabled)}
              className="w-full flex items-center justify-between rounded-lg border border-border/40 bg-card/40 px-4 py-3 text-left transition-all app-motion-base hover:bg-accent/30"
            >
              <div>
                <div className="text-sm font-medium">Disable animations</div>
                <div className="text-xs text-muted-foreground mt-1">
                  Turns off transitions and animated effects across the app.
                </div>
              </div>
              <span
                className={cn(
                  'relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors app-motion-base',
                  !animationsEnabled ? 'bg-primary' : 'bg-muted-foreground/30',
                )}
              >
                <span
                  className={cn(
                    'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform app-motion-base',
                    !animationsEnabled ? 'translate-x-4' : 'translate-x-0',
                  )}
                />
              </span>
            </button>

            <div>
              <label className="text-sm font-medium mb-2 block">Animation speed</label>
              <div className="flex gap-2">
                {ANIMATION_SPEED_OPTIONS.map((speed) => (
                  <Button
                    key={speed}
                    variant={animationSpeed === speed ? 'default' : 'outline'}
                    onClick={() => setAnimationSpeed(speed as AnimationSpeed)}
                    disabled={!animationsEnabled}
                  >
                    {speed.charAt(0).toUpperCase() + speed.slice(1)}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                System reduced-motion is respected automatically.
              </p>
            </div>
          </div>
        </section>

        <section className="mb-8">
          <h2 className="text-lg font-semibold mb-4">Canvas</h2>
          <div className="max-w-md space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium block">Default web card mode</label>
              <Select
                value={canvasWebCardDefaultMode}
                onValueChange={(value) => setCanvasWebCardDefaultMode(value as 'preview' | 'embed')}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="preview">Preview</SelectItem>
                  <SelectItem value="embed">Embed</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                New web cards use this mode by default. Individual cards can still override it.
              </p>
            </div>

            <button
              onClick={() => setCanvasWebCardAutoLoad(!canvasWebCardAutoLoad)}
              className="w-full flex items-center justify-between rounded-lg border border-border/40 bg-card/40 px-4 py-3 text-left transition-all app-motion-base hover:bg-accent/30"
            >
              <div>
                <div className="text-sm font-medium">Disable web preview auto-load</div>
                <div className="text-xs text-muted-foreground mt-1">
                  When enabled, canvas web cards wait for a manual preview load instead of fetching
                  immediately.
                </div>
              </div>
              <span
                className={cn(
                  'relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors app-motion-base',
                  !canvasWebCardAutoLoad ? 'bg-primary' : 'bg-muted-foreground/30',
                )}
              >
                <span
                  className={cn(
                    'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform app-motion-base',
                    !canvasWebCardAutoLoad ? 'translate-x-4' : 'translate-x-0',
                  )}
                />
              </span>
            </button>
          </div>
        </section>

        <section className="mb-8">
          <h2 className="text-lg font-semibold mb-4">OCR</h2>
          <SettingsOcrSection
            ocrLanguage={ocrLanguage}
            setOcrLanguage={setOcrLanguage}
            ocrModelSource={ocrModelSource}
            setOcrModelSource={setOcrModelSource}
            ocrRenderScale={ocrRenderScale}
            setOcrRenderScale={setOcrRenderScale}
            ocrPreprocessingMode={ocrPreprocessingMode}
            setOcrPreprocessingMode={setOcrPreprocessingMode}
          />
        </section>
      </div>
    </div>
  );
}
