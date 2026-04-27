import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import {
  Command,
  CommandInput,
  CommandList,
} from '../ui/command';
import {
  MODE_PLACEHOLDER,
} from './commandBarUtils';
import { CommandBarModeContent, CommandBarModeHints } from './CommandBarModeContent';
import { useCommandBarShell } from './useCommandBarShell';

// ── Main component ─────────────────────────────────────────────────────────────

export function CommandBar() {
  const { open, setOpen, input, setInput, mode, insertCompletion, ctx } = useCommandBarShell();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="top-[30%] translate-y-0 overflow-hidden p-0 gap-0 rounded-xl! sm:max-w-xl"
        showCloseButton={false}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Command Bar</DialogTitle>
          <DialogDescription>
            Search notes, run actions, calculate expressions, filter by tag or type, browse insert snippets, or search Nerd Font icons.
          </DialogDescription>
        </DialogHeader>

        <Command shouldFilter={false} className="rounded-xl!">
          <CommandInput
            placeholder={MODE_PLACEHOLDER[mode.type]}
            value={input}
            onValueChange={setInput}
            onKeyDown={(e) => {
              if (mode.type !== 'insert' || !insertCompletion) return;
              if (e.key !== 'Tab' && e.key !== 'ArrowRight') return;
              const selection = window.getSelection();
              if (selection && !selection.isCollapsed) return;
              e.preventDefault();
              const prefix = input.trimStart().startsWith('/') ? '/' : input.trimStart().startsWith('insert:') ? 'insert:' : '/';
              setInput(`${prefix}${insertCompletion}`);
            }}
          />
          {mode.type === 'insert' && insertCompletion && (
            <div className="px-3 pb-1 text-[11px] text-muted-foreground">
              <span className="font-mono text-foreground/80">{input.trimStart().startsWith('insert:') ? 'insert:' : '/'}</span>
              <span className="font-mono text-foreground/80">{mode.query}</span>
              <span className="font-mono opacity-50">{insertCompletion.slice(mode.query.trimStart().length)}</span>
              <span className="ml-2 text-[10px] uppercase tracking-wide opacity-60">Tab</span>
              <span className="ml-1 text-[10px] uppercase tracking-wide opacity-60">Right</span>
            </div>
          )}
          <CommandList className="max-h-80">
            <CommandBarModeContent mode={mode} ctx={ctx} />
          </CommandList>
          <CommandBarModeHints current={mode.type} />
        </Command>
      </DialogContent>
    </Dialog>
  );
}
