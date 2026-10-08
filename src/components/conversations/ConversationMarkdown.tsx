import { memo, useMemo } from 'react';

import { openNonVaultMarkdownPreviewLink } from '../editor/markdownLinkOpen';

import { renderChatMarkdown } from './chatFormat';

export const ConversationMarkdown = memo(function ConversationMarkdown({
  content,
}: {
  content: string;
}) {
  const html = useMemo(() => renderChatMarkdown(content), [content]);
  return (
    <div
      className="conversation-markdown"
      // Sanitized above: no raw HTML, attributes limited to href/start.
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(event) => {
        const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');
        if (!anchor) return;
        // Never navigate the app webview; hand links to the system browser.
        event.preventDefault();
        openNonVaultMarkdownPreviewLink(anchor.href);
      }}
    />
  );
});
