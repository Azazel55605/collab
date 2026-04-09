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
import { TableEditorDialog } from './TableEditorDialog';
import {
  createEmptyTable,
  parseMarkdownTable,
  renderMarkdownTable,
  type MarkdownTableModel,
} from './tableMarkdown';

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
  { icon: <Hash size={13} />,    label: 'Math Block',    text: '$$\n\n$$' },
  { icon: <FileCode size={13} />, label: 'Code Block',    text: '```\n\n```' },
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

export function EditorToolbar({ relativePath, editorRef }: EditorToolbarProps) {
  const ed = () => editorRef.current;
  const [tableDialogOpen, setTableDialogOpen] = useState(false);
  const [tableDialogMode, setTableDialogMode] = useState<'insert' | 'edit'>('insert');
  const [tableModel, setTableModel] = useState<MarkdownTableModel>(createEmptyTable());
  const [tableReplaceRange, setTableReplaceRange] = useState<{ from: number; to: number } | null>(null);

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
                <TBtn
                  key={b.label}
                  icon={b.icon}
                  label={b.label}
                  onClick={() => ed()?.insertLine(b.prefix)}
                />
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
                ) : (
                  <TBtn
                    key={b.label}
                    icon={b.icon}
                    label={b.label}
                    onClick={() => ed()?.insertSnippet(b.text)}
                  />
                )
              ))}
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
    </>
  );
}
