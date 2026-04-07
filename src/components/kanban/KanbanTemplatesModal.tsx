import { useEffect, useState } from 'react';
import {
  ArrowLeftRight,
  Download,
  FileJson,
  LayoutDashboard,
  MoreHorizontal,
  Plus,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import { tauriCommands } from '../../lib/tauri';
import type { KanbanBoard } from '../../types/kanban';
import type { KanbanTemplate, TemplateSource } from '../../types/template';
import type { NoteFile } from '../../types/vault';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Input } from '../ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { ConfirmDeleteDialog, InputDialog } from '../vault/VaultDialogs';

interface VisibleTemplate {
  key: string;
  name: string;
  hash: string;
  variants: KanbanTemplate[];
}

interface Props {
  open: boolean;
  vaultPath: string;
  boards: NoteFile[];
  onOpenChange: (open: boolean) => void;
  onTemplateApplied: (file: NoteFile) => void;
}

function sourceLabel(source: TemplateSource): string {
  return source === 'vault' ? 'Vault' : 'App';
}

function ensureKanbanPath(value: string): string {
  const trimmed = value.trim();
  return trimmed.endsWith('.kanban') ? trimmed : `${trimmed}.kanban`;
}

function groupTemplates(templates: KanbanTemplate[]): VisibleTemplate[] {
  const groups = new Map<string, VisibleTemplate>();

  for (const template of templates) {
    const key = `${template.name.toLocaleLowerCase()}::${template.hash}`;
    const existing = groups.get(key);
    if (existing) {
      existing.variants.push(template);
      continue;
    }
    groups.set(key, {
      key,
      name: template.name,
      hash: template.hash,
      variants: [template],
    });
  }

  return [...groups.values()]
    .map((entry) => ({
      ...entry,
      variants: [...entry.variants].sort((a, b) => a.source.localeCompare(b.source)),
    }))
    .sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
      b.variants.length - a.variants.length,
    );
}

function hasSource(entry: VisibleTemplate, source: TemplateSource): boolean {
  return entry.variants.some((variant) => variant.source === source);
}

function getPrimaryVariant(entry: VisibleTemplate): KanbanTemplate {
  return entry.variants.find((variant) => variant.source === 'vault') ?? entry.variants[0];
}

function hasDifferentSourceCopy(
  templates: KanbanTemplate[],
  template: KanbanTemplate,
  source: TemplateSource,
): boolean {
  return templates.some((other) =>
    other.name.localeCompare(template.name, undefined, { sensitivity: 'base' }) === 0 &&
    other.source === source &&
    other.hash !== template.hash,
  );
}

function formatTimestamp(timestamp: number): string {
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return 'Unknown';
  }
}

export default function KanbanTemplatesModal({
  open,
  vaultPath,
  boards,
  onOpenChange,
  onTemplateApplied,
}: Props) {
  const [templates, setTemplates] = useState<KanbanTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createSource, setCreateSource] = useState<TemplateSource>('vault');
  const [selectedBoardPath, setSelectedBoardPath] = useState<string>(boards[0]?.relativePath ?? '');
  const [importSource, setImportSource] = useState<TemplateSource>('vault');
  const [applyTarget, setApplyTarget] = useState<KanbanTemplate | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<KanbanTemplate | null>(null);

  useEffect(() => {
    if (!open) return;
    setSelectedBoardPath((current) => current || boards[0]?.relativePath || '');
  }, [open, boards]);

  async function loadTemplates() {
    setLoading(true);
    try {
      const next = await tauriCommands.listKanbanTemplates(vaultPath);
      setTemplates(next);
    } catch (error) {
      toast.error(`Failed to load templates: ${error}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    void loadTemplates();
  }, [open, vaultPath]);

  async function handleCreateBlankTemplate() {
    const templateName = createName.trim();
    if (!templateName) return;
    try {
      await tauriCommands.createBlankKanbanTemplate(vaultPath, createSource, templateName);
      setCreateName('');
      await loadTemplates();
      toast.success(`Created ${sourceLabel(createSource).toLowerCase()} template "${templateName}"`);
    } catch (error) {
      toast.error(`Failed to create template: ${error}`);
    }
  }

  async function handleCreateFromBoard() {
    const templateName = createName.trim();
    if (!templateName || !selectedBoardPath) return;
    try {
      const { content } = await tauriCommands.readNote(vaultPath, selectedBoardPath);
      const board = JSON.parse(content) as KanbanBoard;
      await tauriCommands.saveKanbanTemplate(vaultPath, createSource, templateName, board);
      setCreateName('');
      await loadTemplates();
      toast.success(`Saved template from ${selectedBoardPath}`);
    } catch (error) {
      toast.error(`Failed to save template: ${error}`);
    }
  }

  async function handleImportFromFile() {
    const filePath = await tauriCommands.showOpenTemplateFileDialog();
    if (!filePath) return;
    try {
      const template = await tauriCommands.importKanbanTemplateFromFile(vaultPath, importSource, filePath);
      await loadTemplates();
      toast.success(`Imported "${template.name}" to ${sourceLabel(importSource).toLowerCase()} templates`);
    } catch (error) {
      toast.error(`Failed to import template: ${error}`);
    }
  }

  async function handleApplyTemplate(destination: string) {
    if (!applyTarget) return;
    try {
      const file = await tauriCommands.applyKanbanTemplate(
        vaultPath,
        applyTarget.source,
        applyTarget.name,
        ensureKanbanPath(destination),
      );
      setApplyTarget(null);
      onTemplateApplied(file);
      toast.success(`Created board from "${applyTarget.name}"`);
    } catch (error) {
      toast.error(`Failed to apply template: ${error}`);
    }
  }

  async function handleDeleteTemplate() {
    if (!deleteTarget) return;
    try {
      await tauriCommands.deleteKanbanTemplate(vaultPath, deleteTarget.source, deleteTarget.name);
      setDeleteTarget(null);
      await loadTemplates();
      toast.success(`Deleted ${sourceLabel(deleteTarget.source).toLowerCase()} template "${deleteTarget.name}"`);
    } catch (error) {
      toast.error(`Failed to delete template: ${error}`);
    }
  }

  async function handleCopyTemplate(template: KanbanTemplate) {
    const targetSource: TemplateSource = template.source === 'vault' ? 'app' : 'vault';
    try {
      await tauriCommands.copyKanbanTemplate(vaultPath, template.source, targetSource, template.name);
      await loadTemplates();
      toast.success(`Copied "${template.name}" to ${sourceLabel(targetSource).toLowerCase()} templates`);
    } catch (error) {
      toast.error(`Failed to copy template: ${error}`);
    }
  }

  async function handleExportTemplate(template: KanbanTemplate) {
    const filePath = await tauriCommands.showSaveTemplateFileDialog(`${template.name}.json`);
    if (!filePath) return;
    try {
      await tauriCommands.exportKanbanTemplateToFile(vaultPath, template.source, template.name, filePath);
      toast.success(`Exported "${template.name}"`);
    } catch (error) {
      toast.error(`Failed to export template: ${error}`);
    }
  }

  const visibleTemplates = groupTemplates(templates);

  return (
    <>
      <InputDialog
        open={!!applyTarget}
        variant="create-kanban"
        initialValue={applyTarget?.name ?? ''}
        onConfirm={handleApplyTemplate}
        onCancel={() => setApplyTarget(null)}
      />

      <ConfirmDeleteDialog
        open={!!deleteTarget}
        name={
          deleteTarget
            ? `${deleteTarget.name} (${sourceLabel(deleteTarget.source).toLowerCase()} template)`
            : ''
        }
        isFolder={false}
        onConfirm={handleDeleteTemplate}
        onCancel={() => setDeleteTarget(null)}
      />

      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-4xl w-full max-h-[88vh] overflow-hidden p-0 gap-0">
          <DialogHeader className="px-5 pt-5 pb-4 border-b border-border/40">
            <div className="flex items-center gap-3">
              <span className="flex items-center justify-center w-10 h-10 rounded-xl bg-emerald-500/12 text-emerald-400 shrink-0">
                <LayoutDashboard size={18} />
              </span>
              <div className="min-w-0">
                <DialogTitle>Kanban Templates</DialogTitle>
                <DialogDescription className="mt-1 text-xs">
                  Manage vault and app-wide board templates, then create new boards from them.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <div className="grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)] min-h-0 flex-1">
            <div className="border-b lg:border-b-0 lg:border-r border-border/30 p-4 space-y-4">
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                  <Plus size={12} />
                  Create Template
                </div>
                <Input
                  value={createName}
                  onChange={(event) => setCreateName(event.target.value)}
                  placeholder="Sprint Board"
                />
                <Select value={createSource} onValueChange={(value) => setCreateSource(value as TemplateSource)}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose destination" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="vault">Vault templates</SelectItem>
                    <SelectItem value="app">App-wide templates</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={selectedBoardPath} onValueChange={setSelectedBoardPath} disabled={boards.length === 0}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose board to snapshot" />
                  </SelectTrigger>
                  <SelectContent>
                    {boards.map((board) => (
                      <SelectItem key={board.relativePath} value={board.relativePath}>
                        {board.relativePath}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant="outline"
                    onClick={handleCreateBlankTemplate}
                    disabled={!createName.trim()}
                  >
                    <Sparkles />
                    Blank
                  </Button>
                  <Button
                    onClick={handleCreateFromBoard}
                    disabled={!createName.trim() || !selectedBoardPath}
                  >
                    <FileJson />
                    From Board
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                  <Upload size={12} />
                  Import File
                </div>
                <Select value={importSource} onValueChange={(value) => setImportSource(value as TemplateSource)}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose import destination" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="vault">Into this vault</SelectItem>
                    <SelectItem value="app">Into app-wide templates</SelectItem>
                  </SelectContent>
                </Select>
                <Button variant="outline" className="w-full" onClick={handleImportFromFile}>
                  <Upload />
                  Import Template File
                </Button>
              </div>
            </div>

            <div className="min-h-0 flex flex-col">
              <div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                    Saved Templates
                  </div>
                  <div className="text-[11px] text-muted-foreground/70 mt-1">
                    Identical vault and app templates collapse into one row.
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => void loadTemplates()} disabled={loading}>
                  Refresh
                </Button>
              </div>

              <div className="flex-1 overflow-y-auto p-4">
                {loading ? (
                  <div className="text-sm text-muted-foreground">Loading templates…</div>
                ) : visibleTemplates.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-center text-sm text-muted-foreground gap-3">
                    <LayoutDashboard size={28} className="opacity-35" />
                    <div>
                      <p>No kanban templates yet.</p>
                      <p className="text-xs opacity-70 mt-1">Create one from a board or import a template file.</p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {visibleTemplates.map((entry) => {
                      const primary = getPrimaryVariant(entry);
                      const canCopyToVault =
                        entry.variants.some((variant) => variant.source === 'app') &&
                        !hasSource(entry, 'vault') &&
                        !hasDifferentSourceCopy(templates, primary, 'vault');
                      const canCopyToApp =
                        entry.variants.some((variant) => variant.source === 'vault') &&
                        !hasSource(entry, 'app') &&
                        !hasDifferentSourceCopy(templates, primary, 'app');

                      return (
                        <div
                          key={entry.key}
                          className="rounded-xl border border-border/40 bg-background/60 px-4 py-3"
                        >
                          <div className="flex items-start gap-3">
                            <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-emerald-500/10 text-emerald-400 shrink-0">
                              <LayoutDashboard size={16} />
                            </div>

                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap">
                                <h3 className="text-sm font-medium text-foreground truncate">{entry.name}</h3>
                                {entry.variants.map((variant) => (
                                  <Badge key={`${entry.key}-${variant.source}`} variant="secondary" className="text-[10px]">
                                    {sourceLabel(variant.source)}
                                  </Badge>
                                ))}
                                {entry.variants.length > 1 && (
                                  <Badge variant="outline" className="text-[10px]">
                                    Same content
                                  </Badge>
                                )}
                              </div>

                              <div className="mt-1 text-xs text-muted-foreground/70">
                                Updated {formatTimestamp(primary.updatedAt)}
                              </div>

                              <div className="mt-2 flex flex-wrap gap-2">
                                <Button
                                  size="sm"
                                  onClick={() => setApplyTarget(primary)}
                                >
                                  <LayoutDashboard />
                                  Use Template
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => void handleExportTemplate(primary)}
                                >
                                  <Download />
                                  Export File
                                </Button>
                              </div>
                            </div>

                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon-sm" aria-label={`Manage template ${entry.name}`}>
                                  <MoreHorizontal />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-56">
                                <DropdownMenuLabel>{entry.name}</DropdownMenuLabel>
                                <DropdownMenuItem onSelect={() => setApplyTarget(primary)}>
                                  <LayoutDashboard />
                                  Use Template
                                </DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => void handleExportTemplate(primary)}>
                                  <Download />
                                  Export to File
                                </DropdownMenuItem>
                                {(canCopyToVault || canCopyToApp) && <DropdownMenuSeparator />}
                                {canCopyToVault && (
                                  <DropdownMenuItem onSelect={() => void handleCopyTemplate(primary)}>
                                    <ArrowLeftRight />
                                    Copy to Vault Templates
                                  </DropdownMenuItem>
                                )}
                                {canCopyToApp && (
                                  <DropdownMenuItem onSelect={() => void handleCopyTemplate(primary)}>
                                    <ArrowLeftRight />
                                    Copy to App Templates
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuSeparator />
                                {entry.variants.map((variant) => (
                                  <DropdownMenuItem
                                    key={`${entry.key}-delete-${variant.source}`}
                                    variant="destructive"
                                    onSelect={() => setDeleteTarget(variant)}
                                  >
                                    <Trash2 />
                                    Delete {sourceLabel(variant.source)} Copy
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
