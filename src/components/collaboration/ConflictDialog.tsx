import { useCollabStore } from '../../store/collabStore';
import { useVaultStore } from '../../store/vaultStore';
import { useEditorStore } from '../../store/editorStore';
import { tauriCommands } from '../../lib/tauri';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '../ui/dialog';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';

export function ConflictDialog() {
  const { conflicts, dismissConflict } = useCollabStore();
  const { vault } = useVaultStore();
  const { markSaved } = useEditorStore();
  const conflict = conflicts[0];

  if (!conflict || !vault) return null;

  const resolve = async (content: string) => {
    try {
      const result = await tauriCommands.writeNote(vault.path, conflict.relativePath, content);
      markSaved(conflict.relativePath, result.hash);
      dismissConflict(conflict.relativePath);
      toast.success('Conflict resolved');
    } catch (e) {
      toast.error('Failed to resolve: ' + e);
    }
  };

  return (
    <Dialog open onOpenChange={() => dismissConflict(conflict.relativePath)}>
      <DialogContent className="max-w-3xl glass-strong border-border/50 shadow-2xl shadow-black/50">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-destructive/15 flex items-center justify-center">
              <AlertTriangle size={16} className="text-destructive" />
            </div>
            <div>
              <DialogTitle className="text-base">Merge Conflict</DialogTitle>
              <DialogDescription className="text-xs mt-0.5">
                <Badge variant="secondary" className="text-[11px] font-mono">{conflict.relativePath}</Badge>
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <p className="text-sm text-muted-foreground -mt-1">
          Another user saved this file while you had unsaved changes. Choose which version to keep.
        </p>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-primary" />
              <span className="text-xs font-semibold text-primary">Your version</span>
            </div>
            <pre className="text-[11px] bg-primary/5 border border-primary/15 p-3 rounded-lg overflow-auto max-h-56 whitespace-pre-wrap leading-relaxed font-mono">
              {conflict.ourContent}
            </pre>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-destructive" />
              <span className="text-xs font-semibold text-destructive">Their version (on disk)</span>
            </div>
            <pre className="text-[11px] bg-destructive/5 border border-destructive/15 p-3 rounded-lg overflow-auto max-h-56 whitespace-pre-wrap leading-relaxed font-mono">
              {conflict.theirContent}
            </pre>
          </div>
        </div>

        <DialogFooter className="gap-2 mt-2">
          <Button variant="ghost" size="sm" onClick={() => dismissConflict(conflict.relativePath)}>
            Cancel
          </Button>
          <Button
            variant="outline" size="sm"
            onClick={() => resolve(conflict.theirContent)}
            className="border-destructive/30 text-destructive hover:bg-destructive/10"
          >
            Keep Theirs
          </Button>
          <Button size="sm" onClick={() => resolve(conflict.ourContent)}>
            Keep Mine
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
