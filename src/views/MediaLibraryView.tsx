import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';

import {
  ChevronLeft,
  ChevronRight,
  CodeXml,
  Film,
  Folder,
  Image as ImageIcon,
  LayoutGrid,
  LibraryBig,
  List,
  ListPlus,
  Music2,
  Search,
  SquareArrowOutUpRight,
} from 'lucide-react';

import { DocumentTopBar, getDocumentFolderPath } from '../components/layout/DocumentTopBar';
import {
  AppDialogBody,
  AppDialogContent,
  AppDialogFooter,
  AppDialogHeader,
} from '../components/ui/app-dialog';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { documentVaultIdentity } from '../lib/documentPaneContext';
import { getImagePreviewDataUrl } from '../lib/imagePreview';
import {
  cachedLibraryMediaDetails,
  canPreviewInGallery,
  type LibraryMediaDetails,
  type LibraryMediaKind,
  libraryPreviewKey,
  loadLibraryMediaDetails,
} from '../lib/libraryMediaPreview';
import { mediaKindForPath } from '../lib/mediaFiles';
import { registerMediaCleanup } from '../lib/mediaLifecycle';
import { enqueueMedia } from '../lib/mediaQueue';
import { mediaFileVersion, useRecentMedia } from '../lib/mediaResume';
import { cn } from '../lib/utils';
import { createVaultClient } from '../lib/vaultClient';
import { getVaultDocumentTabType, getVaultDocumentView } from '../lib/vaultLinks';
import { vaultTreeIndex } from '../lib/vaultTreeIndex';
import { useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import { useVaultStore } from '../store/vaultStore';
import type { NoteFile, VaultMeta } from '../types/vault';

import { formatTime } from './mediaFormat';
import MediaQueue from './MediaQueue';

const PAGE_SIZE = 36;
const OPTIONS_KEY = 'collab-media-library-options';
const kinds = {
  image: { label: 'Images', icon: ImageIcon },
  svg: { label: 'SVGs', icon: CodeXml },
  video: { label: 'Videos', icon: Film },
  audio: { label: 'Audio', icon: Music2 },
};
type Filter = 'all' | LibraryMediaKind;
type Item = { file: NoteFile; kind: LibraryMediaKind; folder: string; searchPath: string };
type Options = { layout: 'gallery' | 'list'; group: boolean; resume: boolean };

function readOptions(): Options {
  try {
    const options = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? '{}');
    return {
      layout: options.layout === 'list' ? 'list' : 'gallery',
      group: options.group === true,
      resume: options.resume !== false,
    };
  } catch {
    return { layout: 'gallery', group: false, resume: true };
  }
}

export default function MediaLibraryView() {
  const vault = useVaultStore((state) => state.vault);
  const locked = useVaultStore((state) => state.isVaultLocked);
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <DocumentTopBar title="Media" subtitle={vault?.name} icon={<LibraryBig size={16} />} />
      {vault && !locked ? (
        <Library key={documentVaultIdentity(vault)} vault={vault} />
      ) : (
        <p className="m-auto px-6 text-center text-sm text-muted-foreground">
          {locked ? 'Unlock the vault to browse media.' : 'Open a vault to browse media.'}
        </p>
      )}
    </div>
  );
}

function Library({ vault }: { vault: VaultMeta }) {
  const tree = useVaultStore((state) => state.fileTree);
  const recent = useRecentMedia(vault);
  const [options, setOptions] = useState(readOptions);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const deferred = useDeferredValue(query.trim().toLowerCase());
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, LibraryMediaDetails>>({});
  const viewport = useRef<HTMLDivElement>(null);
  const previewTrigger = useRef<HTMLButtonElement>(null);

  useEffect(
    () =>
      registerMediaCleanup(() => {
        setSelected(null);
        setPreviews({});
      }),
    [],
  );

  const items = useMemo(() => {
    const found: Item[] = [];
    for (const file of vaultTreeIndex(tree).files) {
      const path = file.relativePath;
      const kind =
        mediaKindForPath(path) ??
        (/\.svg$/i.test(path) ? 'svg' : getVaultDocumentTabType(path) === 'image' ? 'image' : null);
      if (kind)
        found.push({
          file,
          kind,
          folder: getDocumentFolderPath(path),
          searchPath: path.toLowerCase(),
        });
    }
    return found;
  }, [tree]);
  const byPath = useMemo(
    () => new Map(items.map((item) => [item.file.relativePath, item])),
    [items],
  );
  const matching = useMemo(
    () =>
      items
        .filter(
          ({ kind, searchPath }) =>
            (filter === 'all' || kind === filter) && searchPath.includes(deferred),
        )
        .sort((a, b) => {
          const folderOrder = options.group ? a.folder.localeCompare(b.folder) : 0;
          return (
            folderOrder ||
            a.file.name.localeCompare(b.file.name) ||
            a.file.relativePath.localeCompare(b.file.relativePath)
          );
        }),
    [items, filter, deferred, options.group],
  );
  const currentPage = Math.min(page, Math.max(0, Math.ceil(matching.length / PAGE_SIZE) - 1));
  const start = currentPage * PAGE_SIZE;
  const groups = new Map<string, Item[]>();
  for (const item of matching.slice(start, start + PAGE_SIZE)) {
    const name = options.group ? item.folder : '';
    const group = groups.get(name);
    if (group) group.push(item);
    else groups.set(name, [item]);
  }

  const continuation = recent
    .flatMap((entry) => {
      const item = byPath.get(entry.path);
      return item &&
        mediaFileVersion(item.file) === entry.fileVersion &&
        entry.position >= 1 &&
        entry.duration > entry.position
        ? [{ item, entry }]
        : [];
    })
    .slice(0, 6);
  const inspected = selected ? byPath.get(selected) : undefined;

  function updateOptions(next: Partial<Options>) {
    const updated = { ...options, ...next };
    setOptions(updated);
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(updated));
  }

  const inspectFile = useCallback((path: string, trigger: HTMLButtonElement) => {
    previewTrigger.current = trigger;
    setSelected(path);
  }, []);

  const identity = documentVaultIdentity(vault);
  const openFile = useCallback(
    (file: NoteFile) => {
      if (
        useVaultStore.getState().isVaultLocked ||
        documentVaultIdentity(useVaultStore.getState().vault) !== identity
      )
        return;
      const type = getVaultDocumentTabType(file.relativePath);
      useEditorStore.getState().openTab(file.relativePath, file.name, type);
      void useUiStore.getState().setActiveView(getVaultDocumentView(type));
    },
    [identity],
  );

  return (
    <div ref={viewport} className="@container min-h-0 flex-1 overflow-auto">
      <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-border/60 bg-background px-4 py-3 @xl:px-7">
        <div className="relative min-w-48 flex-1 @xl:max-w-80">
          <Search
            size={15}
            className="pointer-events-none absolute top-2.5 left-2.5 text-muted-foreground"
          />
          <Input
            type="search"
            aria-label="Search media"
            placeholder="Search media"
            value={query}
            className="pl-8"
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
          />
        </div>
        <div role="group" aria-label="Media layout" className="flex items-center gap-1">
          <Button
            size="icon-sm"
            variant={options.layout === 'gallery' ? 'secondary' : 'ghost'}
            aria-label="Gallery layout"
            aria-pressed={options.layout === 'gallery'}
            onClick={() => updateOptions({ layout: 'gallery' })}
          >
            <LayoutGrid />
          </Button>
          <Button
            size="icon-sm"
            variant={options.layout === 'list' ? 'secondary' : 'ghost'}
            aria-label="List layout"
            aria-pressed={options.layout === 'list'}
            onClick={() => updateOptions({ layout: 'list' })}
          >
            <List />
          </Button>
          <Button
            size="sm"
            variant={options.group ? 'secondary' : 'ghost'}
            aria-pressed={options.group}
            onClick={() => {
              updateOptions({ group: !options.group });
              setPage(0);
            }}
          >
            <Folder /> Group by folder
          </Button>
          <Button
            size="sm"
            variant={options.resume ? 'secondary' : 'ghost'}
            aria-pressed={options.resume}
            onClick={() => updateOptions({ resume: !options.resume })}
          >
            Continue playback
          </Button>
        </div>
      </div>
      <div className="mx-auto max-w-7xl space-y-6 px-4 py-5 @xl:px-7">
        {options.resume &&
        !deferred &&
        filter === 'all' &&
        currentPage === 0 &&
        continuation.length ? (
          <section aria-labelledby="media-continue-title" className="space-y-2">
            <h2 id="media-continue-title" className="text-sm font-semibold">
              Continue watching and listening
            </h2>
            <ul className="grid gap-2 @xl:grid-cols-2 @4xl:grid-cols-3">
              {continuation.map(({ item, entry }) => {
                const Icon = kinds[item.kind].icon;
                return (
                  <li key={entry.path} className="min-w-0">
                    <Button
                      variant="outline"
                      className="h-auto w-full justify-start gap-3 px-3 py-2 text-left"
                      onClick={() => openFile(item.file)}
                    >
                      <Icon className="text-primary" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{item.file.name}</span>
                        <span className="block text-xs font-normal text-muted-foreground">
                          {formatTime(entry.position)} / {formatTime(entry.duration)}
                        </span>
                      </span>
                    </Button>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
        <MediaQueue vault={vault} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div role="group" aria-label="Media type" className="flex flex-wrap gap-1">
            {(['all', ...Object.keys(kinds)] as Filter[]).map((value) => (
              <Button
                key={value}
                size="sm"
                variant={value === filter ? 'secondary' : 'ghost'}
                aria-pressed={value === filter}
                onClick={() => {
                  setFilter(value);
                  setPage(0);
                }}
              >
                {value === 'all' ? 'All media' : kinds[value].label}
              </Button>
            ))}
          </div>
          <p role="status" className="text-xs tabular-nums text-muted-foreground">
            {matching.length} {matching.length === 1 ? 'file' : 'files'}
          </p>
        </div>
        {!matching.length ? (
          <p className="py-16 text-center text-sm text-muted-foreground">
            {items.length
              ? 'No media matches your search or filter.'
              : 'This vault has no media files.'}
          </p>
        ) : null}
        {Array.from(groups, ([folder, group]) => (
          <section key={folder} aria-label={folder || 'Media files'} className="space-y-2">
            {folder ? (
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <Folder size={15} className="text-muted-foreground" />
                {folder}
              </h2>
            ) : null}
            <ul
              className={
                options.layout === 'gallery'
                  ? 'grid grid-cols-[repeat(auto-fill,minmax(min(100%,12rem),1fr))] gap-3'
                  : 'divide-y rounded-lg border'
              }
            >
              {group.map((item) => {
                const key = libraryPreviewKey(vault, item.file);
                return (
                  <MediaItem
                    key={key}
                    item={item}
                    vault={vault}
                    layout={options.layout}
                    details={previews[key] ?? cachedLibraryMediaDetails(key)}
                    onOpen={openFile}
                    onInspect={inspectFile}
                  />
                );
              })}
            </ul>
          </section>
        ))}
        {matching.length > PAGE_SIZE ? (
          <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
            <span>
              {start + 1}–{Math.min(start + PAGE_SIZE, matching.length)} of {matching.length}
            </span>
            <Button
              size="icon-sm"
              variant="outline"
              aria-label="Previous page"
              disabled={currentPage === 0}
              onClick={() => {
                setPage(currentPage - 1);
                viewport.current?.scrollTo(0, 0);
              }}
            >
              <ChevronLeft />
            </Button>
            <Button
              size="icon-sm"
              variant="outline"
              aria-label="Next page"
              disabled={start + PAGE_SIZE >= matching.length}
              onClick={() => {
                setPage(currentPage + 1);
                viewport.current?.scrollTo(0, 0);
              }}
            >
              <ChevronRight />
            </Button>
          </div>
        ) : null}
      </div>
      {inspected ? (
        <MediaInspector
          key={libraryPreviewKey(vault, inspected.file)}
          item={inspected}
          vault={vault}
          onClose={() => setSelected(null)}
          previewTrigger={previewTrigger}
          onOpen={() => openFile(inspected.file)}
          onDetails={(key, details) =>
            setPreviews((current) =>
              Object.fromEntries([
                ...Object.entries(current)
                  .filter(([existing]) => existing !== key)
                  .slice(-11),
                [key, details],
              ]),
            )
          }
        />
      ) : null}
    </div>
  );
}

const MediaItem = memo(function MediaItem({
  item,
  vault,
  layout,
  details,
  onOpen,
  onInspect,
}: {
  item: Item;
  vault: VaultMeta;
  layout: Options['layout'];
  details?: LibraryMediaDetails;
  onOpen(file: NoteFile): void;
  onInspect(path: string, trigger: HTMLButtonElement): void;
}) {
  const { file, kind } = item;
  const Icon = kinds[kind].icon;
  const gallery = layout === 'gallery';
  const target = useRef<HTMLLIElement>(null);
  const [thumbnail, setThumbnail] = useState<string>();
  const image = details?.image ?? thumbnail;

  useEffect(() => {
    const node = target.current;
    if (!node || !gallery || image || !canPreviewInGallery(vault, file, kind)) return;
    const controller = new AbortController();
    const load = () => {
      void getImagePreviewDataUrl(createVaultClient(vault), file.relativePath, {
        signal: controller.signal,
      }).then(
        (url) => {
          if (!controller.signal.aborted) setThumbnail(url);
        },
        () => {},
      );
    };
    if (typeof IntersectionObserver === 'undefined') {
      load();
      return () => controller.abort();
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      observer.disconnect();
      load();
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
      controller.abort();
    };
  }, [file, gallery, image, kind, vault]);

  useEffect(() => registerMediaCleanup(() => setThumbnail(undefined)), []);

  return (
    <li
      ref={target}
      className={cn(
        'group relative min-w-0',
        gallery && 'overflow-hidden rounded-xl border bg-card',
      )}
    >
      <Button
        variant="ghost"
        className={cn(
          'h-auto w-full min-w-0 justify-start rounded-none p-0 text-left hover:bg-accent/40 focus-visible:ring-inset',
          gallery ? 'flex-col items-stretch gap-0' : 'items-center gap-3 px-3 py-2 pr-27',
        )}
        onClick={() => onOpen(file)}
        aria-label={`Open ${file.name}`}
        title={file.relativePath}
      >
        <span
          className={cn(
            'relative grid shrink-0 place-items-center overflow-hidden bg-muted/65 text-primary/65',
            gallery ? 'aspect-video w-full' : 'size-10 rounded-md',
          )}
        >
          {image && (gallery || details?.image) ? (
            <img src={image} alt="" className="size-full object-contain" />
          ) : (
            <Icon aria-hidden className={gallery ? 'size-9' : 'size-4'} />
          )}
          {details?.duration && gallery ? (
            <span className="absolute right-2 bottom-2 rounded bg-black/75 px-1.5 py-0.5 text-xs text-white">
              {formatTime(details.duration)}
            </span>
          ) : null}
        </span>
        <span className={cn('min-w-0 flex-1', gallery && 'w-full px-3 py-2.5 pr-26')}>
          <span className="block truncate text-sm font-medium">{file.name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {item.folder}
            {!gallery && details?.duration ? ` · ${formatTime(details.duration)}` : ''}
          </span>
        </span>
      </Button>
      <div
        className={cn(
          'absolute right-2 flex items-center gap-1',
          gallery ? 'bottom-3' : 'top-1/2 -translate-y-1/2',
        )}
      >
        {mediaKindForPath(file.relativePath) && !vault.isEncrypted ? (
          <Button
            size="icon-xs"
            variant="ghost"
            title="Add to queue"
            aria-label={`Add ${file.name} to queue`}
            onClick={() => enqueueMedia(vault, file.relativePath)}
          >
            <ListPlus />
          </Button>
        ) : null}
        <Button
          size="xs"
          variant="ghost"
          aria-label={`Preview ${file.name}`}
          onClick={(event) => onInspect(file.relativePath, event.currentTarget)}
        >
          Preview
        </Button>
      </div>
    </li>
  );
});

function MediaInspector({
  item,
  vault,
  onClose,
  onOpen,
  onDetails,
  previewTrigger,
}: {
  item: Item;
  vault: VaultMeta;
  onClose(): void;
  onOpen(): void;
  onDetails(key: string, details: LibraryMediaDetails): void;
  previewTrigger: React.RefObject<HTMLButtonElement | null>;
}) {
  const { file, kind } = item;
  const Icon = kinds[kind].icon;
  const [details, setDetails] = useState<LibraryMediaDetails>();
  const [failed, setFailed] = useState(false);
  const report = useRef(onDetails);
  useEffect(() => {
    report.current = onDetails;
  }, [onDetails]);

  useEffect(() => {
    if (vault.isEncrypted && (kind === 'video' || kind === 'audio')) {
      setFailed(true);
      return;
    }
    const controller = new AbortController();
    void loadLibraryMediaDetails(vault, file, kind, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        setDetails(result);
        report.current(libraryPreviewKey(vault, file), result);
      },
      () => {
        if (!controller.signal.aborted) setFailed(true);
      },
    );
    return () => controller.abort();
  }, [file, kind, vault]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AppDialogContent
        size="m"
        onCloseAutoFocus={(event) => {
          if (!previewTrigger.current?.isConnected) return;
          event.preventDefault();
          previewTrigger.current.focus();
        }}
      >
        <AppDialogHeader icon={<Icon />} title={file.name} description={file.relativePath} />
        <AppDialogBody>
          <div className="grid min-h-44 place-items-center overflow-hidden rounded-lg bg-muted/65">
            {details?.image ? (
              <img
                src={details.image}
                alt={`Preview of ${file.name}`}
                className="max-h-72 w-full object-contain"
              />
            ) : (
              <Icon className="size-10 text-primary/65" aria-hidden />
            )}
          </div>
          {details ? (
            <p role="status" className="text-muted-foreground">
              {[
                details.title !== file.name ? details.title : undefined,
                details.artist,
                details.album,
                details.duration ? formatTime(details.duration) : undefined,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          ) : (
            <p role="status" className="text-muted-foreground">
              {failed ? 'Preview unavailable for this file.' : 'Loading preview…'}
            </p>
          )}
        </AppDialogBody>
        <AppDialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button onClick={onOpen}>
            <SquareArrowOutUpRight /> Open file
          </Button>
        </AppDialogFooter>
      </AppDialogContent>
    </Dialog>
  );
}
