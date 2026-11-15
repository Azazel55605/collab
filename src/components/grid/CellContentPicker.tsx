import { useState } from 'react';

import {
  CircuitBoard,
  FileText,
  GitFork,
  Image as ImageIcon,
  Layout,
  LayoutDashboard,
  Settings,
} from 'lucide-react';

import {
  flattenVaultFiles,
  getVaultDocumentTabType,
  getVaultDocumentTitle,
} from '../../lib/vaultLinks';
import type { CellContentType, GridCellContent } from '../../store/gridStore';
import { useNoteIndexStore } from '../../store/noteIndexStore';
import { useVaultStore } from '../../store/vaultStore';
import { Popover, PopoverTrigger } from '../ui/popover';
import {
  KeyHints,
  PickerCommand,
  PickerEmpty,
  PickerGroup,
  PickerInput,
  PickerItem,
  PickerList,
  PopoverPanel,
  PopoverPanelFooter,
} from '../ui/popover-patterns';

const VIEW_OPTIONS: { type: CellContentType; label: string; icon: React.ReactNode }[] = [
  { type: 'graph', label: 'Graph', icon: <GitFork size={14} /> },
  { type: 'settings', label: 'Settings', icon: <Settings size={14} /> },
];

interface Props {
  children: React.ReactNode;
  onSelect: (content: GridCellContent) => void;
}

export default function CellContentPicker({ children, onSelect }: Props) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const notes = useNoteIndexStore((state) => state.notes);
  const fileTree = useVaultStore((state) => state.fileTree);
  const flatFiles = flattenVaultFiles(fileTree);
  const canvasBoards = flatFiles.filter(
    (file) => getVaultDocumentTabType(file.relativePath) === 'canvas',
  );
  const kanbanBoards = flatFiles.filter(
    (file) => getVaultDocumentTabType(file.relativePath) === 'kanban',
  );
  const logicDiagrams = flatFiles.filter(
    (file) => getVaultDocumentTabType(file.relativePath) === 'logic',
  );
  const imageFiles = flatFiles.filter(
    (file) => getVaultDocumentTabType(file.relativePath) === 'image',
  );
  const pdfFiles = flatFiles.filter((file) => getVaultDocumentTabType(file.relativePath) === 'pdf');

  const filteredNotes = search.trim()
    ? notes
        .filter(
          (n) =>
            n.title.toLowerCase().includes(search.toLowerCase()) ||
            n.relativePath.toLowerCase().includes(search.toLowerCase()),
        )
        .slice(0, 12)
    : notes.slice(0, 10);

  const query = search.trim().toLowerCase();
  const filteredCanvasBoards = (
    query
      ? canvasBoards.filter(
          (file) =>
            file.name.toLowerCase().includes(query) ||
            file.relativePath.toLowerCase().includes(query),
        )
      : canvasBoards
  ).slice(0, 8);
  const filteredKanbanBoards = (
    query
      ? kanbanBoards.filter(
          (file) =>
            file.name.toLowerCase().includes(query) ||
            file.relativePath.toLowerCase().includes(query),
        )
      : kanbanBoards
  ).slice(0, 8);
  const filteredLogicDiagrams = (
    query
      ? logicDiagrams.filter(
          (file) =>
            file.name.toLowerCase().includes(query) ||
            file.relativePath.toLowerCase().includes(query),
        )
      : logicDiagrams
  ).slice(0, 8);
  const filteredImageFiles = (
    query
      ? imageFiles.filter(
          (file) =>
            file.name.toLowerCase().includes(query) ||
            file.relativePath.toLowerCase().includes(query),
        )
      : imageFiles
  ).slice(0, 8);
  const filteredPdfFiles = (
    query
      ? pdfFiles.filter(
          (file) =>
            file.name.toLowerCase().includes(query) ||
            file.relativePath.toLowerCase().includes(query),
        )
      : pdfFiles
  ).slice(0, 8);

  const select = (content: GridCellContent) => {
    onSelect(content);
    setOpen(false);
    setSearch('');
  };

  const fileItem = (
    type: CellContentType,
    file: { relativePath: string },
    icon: React.ReactNode,
  ) => (
    <PickerItem
      key={`${type}:${file.relativePath}`}
      value={`${type}:${file.relativePath}`}
      icon={icon}
      title={getVaultDocumentTitle(file.relativePath)}
      detail={folderOf(file.relativePath)}
      onSelect={() =>
        select({
          type,
          relativePath: file.relativePath,
          title: getVaultDocumentTitle(file.relativePath),
        })
      }
    />
  );
  const boards = [
    ...filteredCanvasBoards.map((file) => fileItem('canvas', file, <Layout />)),
    ...filteredKanbanBoards.map((file) => fileItem('kanban', file, <LayoutDashboard />)),
  ];

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch('');
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverPanel side="bottom" align="start" className="w-72">
        <PickerCommand shouldFilter={false}>
          <PickerInput
            placeholder="Search notes and files"
            value={search}
            onValueChange={setSearch}
          />
          <PickerList>
            <PickerEmpty>No matching content found</PickerEmpty>
            {!query && (
              <PickerGroup heading="Views">
                {VIEW_OPTIONS.map(({ type, label, icon }) => (
                  <PickerItem
                    key={type}
                    value={`view:${type}`}
                    icon={icon}
                    title={label}
                    onSelect={() => select({ type, relativePath: null, title: label })}
                  />
                ))}
              </PickerGroup>
            )}
            {filteredNotes.length > 0 && (
              <PickerGroup heading="Notes">
                {filteredNotes.map((note) => (
                  <PickerItem
                    key={note.relativePath}
                    value={`note:${note.relativePath}`}
                    icon={<FileText />}
                    title={note.title || note.relativePath}
                    detail={folderOf(note.relativePath)}
                    onSelect={() =>
                      select({
                        type: 'note',
                        relativePath: note.relativePath,
                        title: note.title || note.relativePath,
                      })
                    }
                  />
                ))}
              </PickerGroup>
            )}
            {boards.length > 0 && <PickerGroup heading="Boards">{boards}</PickerGroup>}
            {filteredLogicDiagrams.length > 0 && (
              <PickerGroup heading="Diagrams">
                {filteredLogicDiagrams.map((file) => fileItem('logic', file, <CircuitBoard />))}
              </PickerGroup>
            )}
            {filteredPdfFiles.length > 0 && (
              <PickerGroup heading="PDFs">
                {filteredPdfFiles.map((file) => fileItem('pdf', file, <FileText />))}
              </PickerGroup>
            )}
            {filteredImageFiles.length > 0 && (
              <PickerGroup heading="Images">
                {filteredImageFiles.map((file) => fileItem('image', file, <ImageIcon />))}
              </PickerGroup>
            )}
          </PickerList>
          <PopoverPanelFooter
            start={
              <KeyHints
                hints={[
                  ['↑↓', 'move'],
                  ['↵', 'show'],
                ]}
              />
            }
          />
        </PickerCommand>
      </PopoverPanel>
    </Popover>
  );
}

function folderOf(relativePath: string) {
  const index = relativePath.lastIndexOf('/');
  return index > 0 ? relativePath.slice(0, index) : 'Vault root';
}
