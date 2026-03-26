import {
  Bold,
  Italic,
  Strikethrough,
  Code,
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
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import type { RefObject } from 'react';
import type { MarkdownEditorHandle } from './MarkdownEditor';

interface EditorToolbarProps {
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
];

function TBtn({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        >
          {icon}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export function EditorToolbar({ editorRef }: EditorToolbarProps) {
  const ed = () => editorRef.current;

  return (
    <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-border bg-background/60 px-2 overflow-x-auto scrollbar-none">
      {INLINE.map((b) => (
        <TBtn
          key={b.label}
          icon={b.icon}
          label={b.label}
          onClick={() => ed()?.insertAround(b.before, b.after, b.placeholder)}
        />
      ))}

      <div className="mx-1 h-4 w-px shrink-0 bg-border" />

      {BLOCK.map((b) => (
        <TBtn
          key={b.label}
          icon={b.icon}
          label={b.label}
          onClick={() => ed()?.insertLine(b.prefix)}
        />
      ))}

      <div className="mx-1 h-4 w-px shrink-0 bg-border" />

      {INSERT.map((b) => (
        <TBtn
          key={b.label}
          icon={b.icon}
          label={b.label}
          onClick={() => ed()?.insertSnippet(b.text)}
        />
      ))}
    </div>
  );
}
