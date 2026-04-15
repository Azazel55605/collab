import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  FileCode,
  Link2,
  Quote,
  List,
  ListOrdered,
  CheckSquare,
  Minus,
  Table,
  Calculator,
  Heading1,
  Heading2,
  Heading3,
  Hash,
  Image,
  Highlighter,
  Tags,
  FileText,
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { useState, type MouseEvent, type RefObject } from 'react';
import type { MarkdownEditorHandle } from './MarkdownEditor';
import {
  DocumentTopBar,
  documentTopBarGroupClass,
  getDocumentBaseName,
  getDocumentFolderPath,
} from '../layout/DocumentTopBar';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
import { TableEditorDialog } from './TableEditorDialog';
import {
  createEmptyTable,
  parseMarkdownTable,
  renderMarkdownTable,
  type MarkdownTableModel,
} from './tableMarkdown';
import {
  createEmptyTaskList,
  renderMarkdownTaskList,
  TaskListEditorDialog,
  type TaskListItemDraft,
} from './TaskListEditorDialog';
import { MathBlockEditorDialog } from './MathBlockEditorDialog';
import { CodeBlockEditorDialog } from './CodeBlockEditorDialog';
import { NerdFontIconPicker } from './NerdFontIconPicker';
import { open } from '@tauri-apps/plugin-dialog';
import { renderMarkdownCodeBlock } from './codeBlockUtils';

interface EditorToolbarProps {
  relativePath: string;
  editorRef: RefObject<MarkdownEditorHandle | null>;
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
  { icon: <Bold size={13} />,        label: 'Bold (Ctrl+B)',   before: '**', after: '**', placeholder: 'bold text' },
  { icon: <Italic size={13} />,      label: 'Italic (Ctrl+I)', before: '_',  after: '_',  placeholder: 'italic text' },
  { icon: <Strikethrough size={13}/>, label: 'Strikethrough',  before: '~~', after: '~~', placeholder: 'text' },
  { icon: <Highlighter size={13} />, label: 'Highlight',       before: '==', after: '==', placeholder: 'highlighted' },
  { icon: <Code size={13} />,        label: 'Inline Code',     before: '`',  after: '`',  placeholder: 'code' },
  { icon: <Calculator size={13} />,  label: 'Inline Math',     before: '$',  after: '$',  placeholder: 'x^2' },
];

const BLOCK: BlockBtn[] = [
  { icon: <Heading1 size={13} />,    label: 'Heading 1',    prefix: '# ' },
  { icon: <Heading2 size={13} />,    label: 'Heading 2',    prefix: '## ' },
  { icon: <Heading3 size={13} />,    label: 'Heading 3',    prefix: '### ' },
  { icon: <Quote size={13} />,       label: 'Blockquote',   prefix: '> ' },
  { icon: <List size={13} />,        label: 'Bullet List',  prefix: '- ' },
  { icon: <ListOrdered size={13} />, label: 'Ordered List', prefix: '1. ' },
  { icon: <CheckSquare size={13} />, label: 'Task List',    prefix: '- [ ] ' },
];

const INSERT: InsertBtn[] = [
  { icon: <Link2 size={13} />,   label: 'Link',          text: '[link text](url)' },
  { icon: <Image size={13} />,   label: 'Image',         text: '![alt text](url)' },
  { icon: <Table size={13} />,   label: 'Table',         text: '| Col 1 | Col 2 | Col 3 |\n| --- | --- | --- |\n| Cell | Cell | Cell |' },
  { icon: <Minus size={13} />,   label: 'Horizontal Rule', text: '\n---\n' },
  { icon: <Hash size={13} />,    label: 'Math Block',    text: '$$\n<cursor>\n$$' },
  { icon: <FileCode size={13} />, label: 'Code Block',    text: '```\n<cursor>\n```' },
];

function TagsBtn() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent('tag:add-tags-line'))}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <Tags size={13} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">Add tags line</TooltipContent>
    </Tooltip>
  );
}

function TBtn({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function ToolBtn({
  icon,
  label,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          {icon}
        </button>
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

export function EditorToolbar({ relativePath, editorRef }: EditorToolbarProps) {
  const ed = () => editorRef.current;
  const [tableDialogOpen, setTableDialogOpen] = useState(false);
  const [tableDialogMode, setTableDialogMode] = useState<'insert' | 'edit'>('insert');
  const [tableModel, setTableModel] = useState<MarkdownTableModel>(createEmptyTable());
  const [tableReplaceRange, setTableReplaceRange] = useState<{ from: number; to: number } | null>(null);
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
  const [mathReplaceRange, setMathReplaceRange] = useState<{ from: number; to: number } | null>(null);
  const [codeDialogOpen, setCodeDialogOpen] = useState(false);
  const [codeDialogMode, setCodeDialogMode] = useState<'insert' | 'edit'>('insert');
  const [codeLanguage, setCodeLanguage] = useState('');
  const [codeContent, setCodeContent] = useState('');
  const [codeReplaceRange, setCodeReplaceRange] = useState<{ from: number; to: number } | null>(null);

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
  };

  const browseImagePath = async () => {
    const result = await open({
      multiple: false,
      title: 'Select Image',
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'] }],
    });
    if (typeof result === 'string') {
      setImagePath(result);
    }
  };

  const applyImageDialog = () => {
    ed()?.insertSnippet(`![${imageAltText.trim()}](${imagePath.trim()})`);
    setImageDialogOpen(false);
  };

  const applyTaskListDialog = (tasks: TaskListItemDraft[]) => {
    ed()?.insertSnippet(renderMarkdownTaskList(tasks));
    setTaskListDialogOpen(false);
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
  };

  return (
    <>
      <DocumentTopBar
        title={getDocumentBaseName(relativePath, 'Note')}
        subtitle={getDocumentFolderPath(relativePath)}
        icon={<FileText size={15} />}
        secondary={
          <>
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
              {BLOCK.map((b) => (
                b.label === 'Task List' ? (
                  <ToolBtn
                    key={b.label}
                    icon={b.icon}
                    label="Task List (Shift-click for visual editor)"
                    onClick={(event) => {
                      if (event.shiftKey) {
                        openTaskListDialog();
                        return;
                      }
                      ed()?.insertLine(b.prefix);
                    }}
                  />
                ) : (
                  <TBtn
                    key={b.label}
                    icon={b.icon}
                    label={b.label}
                    onClick={() => ed()?.insertLine(b.prefix)}
                  />
                )
              ))}
            </div>

            <div className={documentTopBarGroupClass}>
              {INSERT.map((b) => (
                b.label === 'Table' ? (
                  <ToolBtn
                    key={b.label}
                    icon={b.icon}
                    label="Table (Shift-click for visual editor)"
                    onClick={(event) => {
                      if (event.shiftKey) {
                        openVisualTableEditor();
                        return;
                      }
                      ed()?.insertSnippet(b.text);
                    }}
                  />
                ) : b.label === 'Link' ? (
                  <ToolBtn
                    key={b.label}
                    icon={b.icon}
                    label="Link (Shift-click for visual editor)"
                    onClick={(event) => {
                      if (event.shiftKey) {
                        openLinkDialog();
                        return;
                      }
                      ed()?.insertSnippet(b.text);
                    }}
                  />
                ) : b.label === 'Image' ? (
                  <ToolBtn
                    key={b.label}
                    icon={b.icon}
                    label="Image (Shift-click for visual editor)"
                    onClick={(event) => {
                      if (event.shiftKey) {
                        openImageDialog();
                        return;
                      }
                      ed()?.insertSnippet(b.text);
                    }}
                  />
                ) : b.label === 'Math Block' ? (
                  <ToolBtn
                    key={b.label}
                    icon={b.icon}
                    label="Math Block (Shift-click for visual editor)"
                    onClick={(event) => {
                      if (event.shiftKey) {
                        openMathDialog();
                        return;
                      }
                      ed()?.insertSnippet(b.text);
                    }}
                  />
                ) : b.label === 'Code Block' ? (
                  <ToolBtn
                    key={b.label}
                    icon={b.icon}
                    label="Code Block (Shift-click for visual editor)"
                    onClick={(event) => {
                      if (event.shiftKey) {
                        openCodeDialog();
                        return;
                      }
                      ed()?.insertSnippet(b.text);
                    }}
                  />
                ) : (
                  <TBtn
                    key={b.label}
                    icon={b.icon}
                    label={b.label}
                    onClick={() => ed()?.insertSnippet(b.text)}
                  />
                )
              ))}
              <NerdFontIconPicker onInsert={(glyph) => ed()?.insertSnippet(glyph)} />
            </div>

            <div className={documentTopBarGroupClass}>
              <TagsBtn />
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
        }}
        onApply={applyVisualTable}
      />

      <LinkInsertDialog
        open={linkDialogOpen}
        text={linkText}
        url={linkUrl}
        onTextChange={setLinkText}
        onUrlChange={setLinkUrl}
        onOpenChange={setLinkDialogOpen}
        onApply={applyLinkDialog}
      />

      <ImageInsertDialog
        open={imageDialogOpen}
        altText={imageAltText}
        path={imagePath}
        onAltTextChange={setImageAltText}
        onPathChange={setImagePath}
        onBrowse={browseImagePath}
        onOpenChange={setImageDialogOpen}
        onApply={applyImageDialog}
      />

      <TaskListEditorDialog
        open={taskListDialogOpen}
        initialValue={taskListItems}
        onOpenChange={setTaskListDialogOpen}
        onApply={applyTaskListDialog}
      />

      <MathBlockEditorDialog
        open={mathDialogOpen}
        mode={mathDialogMode}
        initialSource={mathSource}
        onOpenChange={(open) => {
          setMathDialogOpen(open);
          if (!open) setMathReplaceRange(null);
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
        }}
        onApply={applyCodeDialog}
      />
    </>
  );
}
