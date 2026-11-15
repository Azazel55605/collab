import { useState } from 'react';

import { ArrowDown, ArrowUp, Play, X } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import {
  editMediaQueue,
  loadMediaPlaylist,
  type MediaPlaylist,
  playQueuedMedia,
  readMediaPlaylists,
  useMediaQueue,
  writeMediaPlaylists,
} from '../lib/mediaQueue';
import { useMediaResumeAccount } from '../lib/mediaResume';
import type { VaultMeta } from '../types/vault';

export default function MediaQueue({ vault }: { vault: VaultMeta }) {
  const paths = useMediaQueue((state) => state.paths);
  const account = useMediaResumeAccount(vault);
  return account || paths.length ? (
    <QueueContents key={account ?? ''} vault={vault} paths={paths} canSave={!!account} />
  ) : null;
}

function QueueContents({
  vault,
  paths,
  canSave,
}: {
  vault: VaultMeta;
  paths: string[];
  canSave: boolean;
}) {
  const [playlists, setPlaylists] = useState(() => readMediaPlaylists(vault));
  const [name, setName] = useState('');
  if (!paths.length && !playlists.length) return null;

  function save(next: MediaPlaylist[]) {
    if (!writeMediaPlaylists(vault, next)) {
      toast.error('Could not save playlists on this device.');
      return false;
    }
    setPlaylists(next);
    return true;
  }
  return (
    <section aria-labelledby="media-queue-title" className="space-y-2">
      <h2 id="media-queue-title" className="text-sm font-semibold">
        Playback queue
      </h2>
      {paths.length ? (
        <ol className="max-h-60 divide-y overflow-auto rounded-lg border">
          {paths.map((path, index) => (
            <li key={path} className="flex min-w-0 items-center gap-1 px-2 py-1">
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Play ${path}`}
                onClick={() => void playQueuedMedia(vault, path)}
              >
                <Play />
              </Button>
              <span className="flex-1 truncate text-sm" title={path}>
                {path}
              </span>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Move ${path} up`}
                disabled={index === 0}
                onClick={() => editMediaQueue(vault, path, -1)}
              >
                <ArrowUp />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Move ${path} down`}
                disabled={index === paths.length - 1}
                onClick={() => editMediaQueue(vault, path, 1)}
              >
                <ArrowDown />
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Remove ${path} from queue`}
                onClick={() => editMediaQueue(vault, path, 0)}
              >
                <X />
              </Button>
            </li>
          ))}
        </ol>
      ) : null}
      {canSave && paths.length ? (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const title = name.trim();
            if (!title) return;
            if (
              save(
                [
                  { name: title, paths },
                  ...playlists.filter((playlist) => playlist.name !== title),
                ].slice(0, 20),
              )
            )
              setName('');
          }}
        >
          <Input
            className="max-w-64"
            aria-label="Playlist name"
            placeholder="Playlist name"
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.currentTarget.value)}
          />
          <Button size="sm" variant="outline" type="submit" disabled={!name.trim()}>
            {playlists.some((playlist) => playlist.name === name.trim())
              ? 'Update playlist'
              : 'Save playlist'}
          </Button>
        </form>
      ) : null}
      {playlists.length ? (
        <div>
          <h3 className="text-sm font-medium">Saved playlists</h3>
          <ul className="flex flex-wrap gap-2 pt-2">
            {playlists.map((playlist) => (
              <li
                key={playlist.name}
                className="flex max-w-full min-w-0 items-center rounded-md border"
              >
                <Button
                  variant="ghost"
                  size="sm"
                  className="min-w-0"
                  title={`Load ${playlist.name} into queue`}
                  onClick={() => loadMediaPlaylist(vault, playlist)}
                >
                  <span className="truncate">{playlist.name}</span>
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Delete playlist ${playlist.name}`}
                  onClick={() => save(playlists.filter(({ name }) => name !== playlist.name))}
                >
                  <X />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
