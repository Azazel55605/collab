import { type RefObject, useEffect, useState } from 'react';

import { open } from '@tauri-apps/plugin-dialog';
import {
  Bold,
  Calculator,
  CheckSquare,
  Code,
  FileCode,
  FileText,
  Hash,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  Image,
  Italic,
  Link2,
  List,
  ListOrdered,
  MessageSquareQuote,
  Minus,
  NotebookPen,
  Printer,
  Quote,
  ScrollText,
  Strikethrough,
  Table,
  Tags,
} from 'lucide-react';

import type { DocumentStatus } from '../../lib/documentSessionController';
import {
  EDITOR_TOOLBAR_ACTION_EVENT,
  type EditorToolbarAction,
} from '../../lib/editorToolbarActions';
import { requestNotePdfExport } from '../../lib/notePdfExport';
import { DocumentStatusPill } from '../layout/DocumentStatusPill';
import {
  DocumentMoreMenu,
  DocumentTopBar,
  documentTopBarGroupClass,
  DocumentTopBarIconButton,
  DocumentTopBarMenuButton,
  getDocumentBaseName,
  getDocumentFolderPath,
} from '../layout/DocumentTopBar';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Input } from '../ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

import { CodeBlockEditorDialog } from './CodeBlockEditorDialog';
import { renderMarkdownCodeBlock } from './codeBlockUtils';
import type { MarkdownEditorHandle } from './MarkdownEditor';
import { MathBlockEditorDialog } from './MathBlockEditorDialog';
import { NerdFontIconPicker } from './NerdFontIconPicker';
import { buildCalloutSnippet } from './noteAuthoring';
import { NoteSnippetsDialog } from './NoteSnippetsDialog';
import { TableEditorDialog } from './TableEditorDialog';
import {
  createEmptyTable,
  type MarkdownTableModel,
  parseMarkdownTable,
  renderMarkdownTable,
} from './tableMarkdown';
import {
  createEmptyTaskList,
  renderMarkdownTaskList,
  TaskListEditorDialog,
  type TaskListItemDraft,
} from './TaskListEditorDialog';

interface EditorToolbarProps {
  relativePath: string;
  editorRef: RefObject<MarkdownEditorHandle | null>;
  documentStatus?: DocumentStatus;
}

interface InlineBtn {
  icon: React.ReactNode;
  label: string;
  before: string;
  after: string;
  placeholder: string;
}

interface BlockBtn {
  icon: React.ReactNode;
  label: string;
  prefix: string;
}

interface InsertBtn {
  icon: React.ReactNode;
  label: string;
  text: string;
}

interface LinkDialogProps {
  open: boolean;
  text: string;
  url: string;
  onTextChange: (value: string) => void;
  onUrlChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onApply: () => void;
}

interface ImageDialogProps {
  open: boolean;
  altText: string;
  path: string;
  onAltTextChange: (value: string) => void;
  onPathChange: (value: string) => void;
  onBrowse: () => void;
  onOpenChange: (open: boolean) => void;
  onApply: () => void;
}

const INLINE: InlineBtn[] = [
  {
    icon: <Bold size={13} />,
    label: 'Bold (Ctrl+B)',
    before: '**',
    after: '**',
    placeholder: 'bold text',
  },
  {
    icon: <Italic size={13} />,
    label: 'Italic (Ctrl+I)',
    before: '_',
    after: '_',
    placeholder: 'italic text',
  },
  {
    icon: <Strikethrough size={13} />,
    label: 'Strikethrough (Ctrl+Shift+X)',
    before: '~~',
    after: '~~',
    placeholder: 'text',
  },
  {
    icon: <Highlighter size={13} />,
    label: 'Highlight',
    before: '==',
    after: '==',
    placeholder: 'highlighted',
  },
  { icon: <Code size={13} />, label: 'Inline Code', before: '`', after: '`', placeholder: 'code' },
  {
    icon: <Calculator size={13} />,
    label: 'Inline Math',
    before: '$',
    after: '$',
    placeholder: 'x^2',
  },
];

const HEADINGS: BlockBtn[] = [
  { icon: <Heading1 />, label: 'Heading 1', prefix: '# ' },
  { icon: <Heading2 />, label: 'Heading 2', prefix: '## ' },
  { icon: <Heading3 />, label: 'Heading 3', prefix: '### ' },
  { icon: <Quote />, label: 'Quote', prefix: '> ' },
];

const LISTS: BlockBtn[] = [
  { icon: <List size={13} />, label: 'Bullet list', prefix: '- ' },
  { icon: <ListOrdered size={13} />, label: 'Numbered list', prefix: '1. ' },
  { icon: <CheckSquare size={13} />, label: 'Task list', prefix: '- [ ] ' },
];

const QUICK_INSERT: InsertBtn[] = [
  { icon: <Link2 size={13} />, label: 'Link', text: '[link text](url)' },
  { icon: <Image size={13} />, label: 'Image', text: '![alt text](url)' },
  {
    icon: <Table size={13} />,
    label: 'Table',
    text: '| Col 1 | Col 2 | Col 3 |\n| --- | --- | --- |\n| Cell | Cell | Cell |',
  },
];

function TBtn({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DocumentTopBarIconButton
          aria-label={label.replace(/ \(.*\)$/, '')}
          onClick={onClick}
          className="text-muted-foreground"
        >
          {icon}
        </DocumentTopBarIconButton>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function LinkInsertDialog({
  open,
  text,
  url,
  onTextChange,
  onUrlChange,
  onOpenChange,
  onApply,
}: LinkDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Insert Link</DialogTitle>
          <DialogDescription>
            Enter the visible link text and the target URL, then insert the markdown link.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-1">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Link text</span>
            <Input
              value={text}
              onChange={(event) => onTextChange(event.target.value)}
              placeholder="Open project site"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">URL</span>
            <Input
              value={url}
              onChange={(event) => onUrlChange(event.target.value)}
              placeholder="https://example.com"
            />
          </label>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={onApply} disabled={!text.trim() || !url.trim()}>
            Insert Link
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImageInsertDialog({
  open,
  altText,
  path,
  onAltTextChange,
  onPathChange,
  onBrowse,
  onOpenChange,
  onApply,
}: ImageDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Insert Image</DialogTitle>
          <DialogDescription>
            Enter the label and image path, or browse for a file, then insert the markdown image.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 py-1">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Name</span>
            <Input
              value={altText}
              onChange={(event) => onAltTextChange(event.target.value)}
              placeholder="Diagram"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Path</span>
            <div className="flex gap-2">
              <Input
                value={path}
                onChange={(event) => onPathChange(event.target.value)}
                placeholder="Pictures/example.png"
              />
              <Button type="button" variant="outline" onClick={onBrowse}>
                Browse
              </Button>
            </div>
          </label>
        </div>
        <DialogFooter className="gap-2 sm:justify-between">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={onApply} disabled={!altText.trim() || !path.trim()}>
            Insert Image
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function EditorToolbar({ relativePath, editorRef, documentStatus }: EditorToolbarProps) {
  const ed = () => editorRef.current;
  const restoreEditorFocus = () => {
    window.requestAnimationFrame(() => {
      ed()?.focus();
    });
  };
  const [tableDialogOpen, setTableDialogOpen] = useState(false);
  const [tableDialogMode, setTableDialogMode] = useState<'insert' | 'edit'>('insert');
  const [tableModel, setTableModel] = useState<MarkdownTableModel>(createEmptyTable());
  const [tableReplaceRange, setTableReplaceRange] = useState<{ from: number; to: number } | null>(
    null,
  );
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [linkText, setLinkText] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [imageDialogOpen, setImageDialogOpen] = useState(false);
  const [imageAltText, setImageAltText] = useState('');
  const [imagePath, setImagePath] = useState('');
  const [taskListDialogOpen, setTaskListDialogOpen] = useState(false);
  const [taskListItems, setTaskListItems] = useState<TaskListItemDraft[]>(createEmptyTaskList());
  const [mathDialogOpen, setMathDialogOpen] = useState(false);
  const [mathDialogMode, setMathDialogMode] = useState<'insert' | 'edit'>('insert');
  const [mathSource, setMathSource] = useState('');
  const [mathReplaceRange, setMathReplaceRange] = useState<{ from: number; to: number } | null>(
    null,
  );
  const [codeDialogOpen, setCodeDialogOpen] = useState(false);
  const [codeDialogMode, setCodeDialogMode] = useState<'insert' | 'edit'>('insert');
  const [codeLanguage, setCodeLanguage] = useState('');
  const [codeContent, setCodeContent] = useState('');
  const [codeReplaceRange, setCodeReplaceRange] = useState<{ from: number; to: number } | null>(
    null,
  );
  const [snippetsDialogOpen, setSnippetsDialogOpen] = useState(false);

  useEffect(() => {
    const handler = (event: Event) => {
      const action = (event as CustomEvent<{ action?: EditorToolbarAction }>).detail?.action;
      switch (action) {
        case 'table':
          openVisualTableEditor();
          break;
        case 'link':
          openLinkDialog();
          break;
        case 'image':
          openImageDialog();
          break;
        case 'taskList':
          openTaskListDialog();
          break;
        case 'math':
          openMathDialog();
          break;
        case 'code':
          openCodeDialog();
          break;
        case 'snippets':
          setSnippetsDialogOpen(true);
          break;
        default:
          break;
      }
    };

    window.addEventListener(EDITOR_TOOLBAR_ACTION_EVENT, handler);
    return () => window.removeEventListener(EDITOR_TOOLBAR_ACTION_EVENT, handler);
  }, []);

  const openVisualTableEditor = () => {
    const currentTable = ed()?.getTableAtCursor();
    if (currentTable) {
      const parsed = parseMarkdownTable(currentTable.text);
      if (parsed) {
        setTableModel(parsed);
        setTableReplaceRange({ from: currentTable.from, to: currentTable.to });
        setTableDialogMode('edit');
        setTableDialogOpen(true);
        return;
      }
    }

    setTableModel(createEmptyTable());
    setTableReplaceRange(null);
    setTableDialogMode('insert');
    setTableDialogOpen(true);
  };

  const applyVisualTable = (nextModel: MarkdownTableModel) => {
    const markdown = renderMarkdownTable(nextModel);
    if (tableReplaceRange) {
      ed()?.replaceRange(tableReplaceRange.from, tableReplaceRange.to, markdown);
    } else {
      ed()?.insertSnippet(markdown);
    }
    setTableDialogOpen(false);
    setTableReplaceRange(null);
    restoreEditorFocus();
  };

  const openLinkDialog = () => {
    setLinkText('');
    setLinkUrl('');
    setLinkDialogOpen(true);
  };

  const openImageDialog = () => {
    setImageAltText('');
    setImagePath('');
    setImageDialogOpen(true);
  };

  const openTaskListDialog = () => {
    setTaskListItems(createEmptyTaskList());
    setTaskListDialogOpen(true);
  };

  const openMathDialog = () => {
    const currentMathBlock = ed()?.getMathBlockAtCursor();
    if (currentMathBlock) {
      setMathSource(currentMathBlock.text);
      setMathReplaceRange({ from: currentMathBlock.from, to: currentMathBlock.to });
      setMathDialogMode('edit');
      setMathDialogOpen(true);
      return;
    }

    setMathSource('');
    setMathReplaceRange(null);
    setMathDialogMode('insert');
    setMathDialogOpen(true);
  };

  const openCodeDialog = () => {
    const currentCodeBlock = ed()?.getCodeBlockAtCursor();
    if (currentCodeBlock) {
      setCodeLanguage(currentCodeBlock.language);
      setCodeContent(currentCodeBlock.code);
      setCodeReplaceRange({ from: currentCodeBlock.from, to: currentCodeBlock.to });
      setCodeDialogMode('edit');
      setCodeDialogOpen(true);
      return;
    }

    setCodeLanguage('');
    setCodeContent('');
    setCodeReplaceRange(null);
    setCodeDialogMode('insert');
    setCodeDialogOpen(true);
  };

  const applyLinkDialog = () => {
    ed()?.insertSnippet(`[${linkText.trim()}](${linkUrl.trim()})`);
    setLinkDialogOpen(false);
    restoreEditorFocus();
  };

  const browseImagePath = async () => {
    const result = await open({
      multiple: false,
      title: 'Select Image',
      filters: [
        {
          name: 'Images',
          extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'],
        },
      ],
    });
    if (typeof result === 'string') {
      setImagePath(result);
    }
  };

  const applyImageDialog = () => {
    ed()?.insertSnippet(`![${imageAltText.trim()}](${imagePath.trim()})`);
    setImageDialogOpen(false);
    restoreEditorFocus();
  };

  const applyTaskListDialog = (tasks: TaskListItemDraft[]) => {
    ed()?.insertSnippet(renderMarkdownTaskList(tasks));
    setTaskListDialogOpen(false);
    restoreEditorFocus();
  };

  const applyMathDialog = (nextSource: string) => {
    const markdown = `$$\n${nextSource.trim()}\n$$`;
    if (mathReplaceRange) {
      ed()?.replaceRange(mathReplaceRange.from, mathReplaceRange.to, markdown);
    } else {
      ed()?.insertSnippet(markdown);
    }
    setMathDialogOpen(false);
    setMathReplaceRange(null);
    restoreEditorFocus();
  };

  const applyCodeDialog = (value: { language: string; code: string }) => {
    const markdown = renderMarkdownCodeBlock(value.language, value.code);
    if (codeReplaceRange) {
      ed()?.replaceRange(codeReplaceRange.from, codeReplaceRange.to, markdown);
    } else {
      ed()?.insertSnippet(markdown);
    }
    setCodeDialogOpen(false);
    setCodeReplaceRange(null);
    restoreEditorFocus();
  };

  return (
    <>
      <DocumentTopBar
        title={getDocumentBaseName(relativePath, 'Note')}
        subtitle={getDocumentFolderPath(relativePath)}
        icon={<FileText />}
        status={documentStatus ? <DocumentStatusPill status={documentStatus} compact /> : undefined}
        meta={
          <DocumentMoreMenu label="More note actions">
            <DropdownMenuItem
              onSelect={() => requestNotePdfExport(relativePath, ed()?.getContent?.())}
            >
              <Printer /> Export as PDF
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => window.dispatchEvent(new CustomEvent('tag:add-tags-line'))}
            >
              <Tags /> Add tags line
            </DropdownMenuItem>
          </DocumentMoreMenu>
        }
        secondary={
          <>
            <div className={documentTopBarGroupClass}>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <DocumentTopBarMenuButton>Paragraph</DocumentTopBarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-44">
                  {HEADINGS.map((b) => (
                    <DropdownMenuItem key={b.label} onSelect={() => ed()?.insertLine(b.prefix)}>
                      {b.icon} {b.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            <div className={documentTopBarGroupClass}>
              {INLINE.map((b) => (
                <TBtn
                  key={b.label}
                  icon={b.icon}
                  label={b.label}
                  onClick={() => ed()?.insertAround(b.before, b.after, b.placeholder)}
                />
              ))}
            </div>

            <div className={documentTopBarGroupClass}>
              {LISTS.map((b) => (
                <TBtn
                  key={b.label}
                  icon={b.icon}
                  label={b.label}
                  onClick={() => ed()?.insertLine(b.prefix)}
                />
              ))}
            </div>

            <div className={documentTopBarGroupClass}>
              {QUICK_INSERT.map((b) => (
                <TBtn
                  key={b.label}
                  icon={b.icon}
                  label={b.label}
                  onClick={() => ed()?.insertSnippet(b.text)}
                />
              ))}
            </div>

            <div className={documentTopBarGroupClass}>
              {/* Non-modal: its items open dialogs, which must own focus afterwards. */}
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger asChild>
                  <DocumentTopBarMenuButton>Insert</DocumentTopBarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-60">
                  <DropdownMenuLabel>Visual editors</DropdownMenuLabel>
                  <DropdownMenuItem onSelect={openVisualTableEditor}>
                    <Table /> Table…
                    <DropdownMenuShortcut>Ctrl+Alt+T</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={openLinkDialog}>
                    <Link2 /> Link…
                    <DropdownMenuShortcut>Ctrl+Alt+L</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={openImageDialog}>
                    <Image /> Image…
                    <DropdownMenuShortcut>Ctrl+Alt+I</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={openTaskListDialog}>
                    <CheckSquare /> Task list…
                    <DropdownMenuShortcut>Ctrl+Alt+K</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={openMathDialog}>
                    <Hash /> Math block…
                    <DropdownMenuShortcut>Ctrl+Alt+M</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={openCodeDialog}>
                    <FileCode /> Code block…
                    <DropdownMenuShortcut>Ctrl+Alt+C</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => ed()?.insertSnippet('\n---\n')}>
                    <Minus /> Horizontal rule
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => ed()?.insertSnippet(buildCalloutSnippet('note'))}
                  >
                    <MessageSquareQuote /> Callout
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => ed()?.insertFootnote()}>
                    <ScrollText /> Footnote
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => setSnippetsDialogOpen(true)}>
                    <NotebookPen /> Note snippets…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <NerdFontIconPicker onInsert={(glyph) => ed()?.insertSnippet(glyph)} />
            </div>
          </>
        }
      />

      <TableEditorDialog
        open={tableDialogOpen}
        initialValue={tableModel}
        mode={tableDialogMode}
        onOpenChange={(open) => {
          setTableDialogOpen(open);
          if (!open) setTableReplaceRange(null);
          if (!open) restoreEditorFocus();
        }}
        onApply={applyVisualTable}
      />

      <LinkInsertDialog
        open={linkDialogOpen}
        text={linkText}
        url={linkUrl}
        onTextChange={setLinkText}
        onUrlChange={setLinkUrl}
        onOpenChange={(open) => {
          setLinkDialogOpen(open);
          if (!open) restoreEditorFocus();
        }}
        onApply={applyLinkDialog}
      />

      <ImageInsertDialog
        open={imageDialogOpen}
        altText={imageAltText}
        path={imagePath}
        onAltTextChange={setImageAltText}
        onPathChange={setImagePath}
        onBrowse={browseImagePath}
        onOpenChange={(open) => {
          setImageDialogOpen(open);
          if (!open) restoreEditorFocus();
        }}
        onApply={applyImageDialog}
      />

      <TaskListEditorDialog
        open={taskListDialogOpen}
        initialValue={taskListItems}
        onOpenChange={(open) => {
          setTaskListDialogOpen(open);
          if (!open) restoreEditorFocus();
        }}
        onApply={applyTaskListDialog}
      />

      <MathBlockEditorDialog
        open={mathDialogOpen}
        mode={mathDialogMode}
        initialSource={mathSource}
        onOpenChange={(open) => {
          setMathDialogOpen(open);
          if (!open) setMathReplaceRange(null);
          if (!open) restoreEditorFocus();
        }}
        onApply={applyMathDialog}
      />

      <CodeBlockEditorDialog
        open={codeDialogOpen}
        mode={codeDialogMode}
        initialLanguage={codeLanguage}
        initialCode={codeContent}
        onOpenChange={(open) => {
          setCodeDialogOpen(open);
          if (!open) setCodeReplaceRange(null);
          if (!open) restoreEditorFocus();
        }}
        onApply={applyCodeDialog}
      />

      <NoteSnippetsDialog
        open={snippetsDialogOpen}
        onOpenChange={(open) => {
          setSnippetsDialogOpen(open);
          if (!open) restoreEditorFocus();
        }}
        onInsert={(body) => {
          ed()?.insertSnippet(body);
          setSnippetsDialogOpen(false);
          restoreEditorFocus();
        }}
      />
    </>
  );
}
