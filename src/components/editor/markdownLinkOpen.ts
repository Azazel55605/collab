import { toast } from 'sonner';

import { tauriCommands } from '../../lib/tauri';

export function openNonVaultMarkdownPreviewLink(
  url: string,
  {
    openExternal = tauriCommands.openExternalUrl,
    onInvalidLink = (message: string) => toast.error(message),
  }: {
    openExternal?: (url: string) => Promise<unknown>;
    onInvalidLink?: (message: string) => void;
  } = {},
) {
  if (!/^https?:\/\//i.test(url)) {
    onInvalidLink('This link is not a valid vault file or web URL.');
    return false;
  }

  void openExternal(url).catch((error) => {
    onInvalidLink(`Failed to open link: ${error}`);
  });
  return true;
}
