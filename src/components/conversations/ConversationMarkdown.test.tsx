import { fireEvent, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { chatPlainText, renderChatMarkdown } from './chatFormat';
import { ConversationMarkdown } from './ConversationMarkdown';

const opener = vi.hoisted(() => ({ openUrl: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@tauri-apps/plugin-opener', () => opener);

it('renders toolbar markdown and never raw HTML, images or script links', () => {
  const html = renderChatMarkdown(
    '**bold** _it_ ~~gone~~ `code`\n- one\n> quote\n<img src=x onerror=alert(1)><script>x</script>\n[bad](javascript:alert(1)) ![i](https://x/y.png)',
  );
  expect(html).toContain('<strong>bold</strong>');
  expect(html).toContain('<em>it</em>');
  expect(html).toContain('<s>gone</s>');
  expect(html).toContain('<code>code</code>');
  expect(html).toContain('<li>one</li>');
  expect(html).toContain('<blockquote>');
  const dom = document.createElement('div');
  dom.innerHTML = html;
  expect(dom.querySelector('img, script, [onerror]')).toBeNull();
  expect([...dom.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
    'https://x/y.png',
  ]);
  // Raw HTML survives only as visible text.
  expect(dom.textContent).toContain('<script>x</script>');
});
it('opens links in the system browser instead of navigating the app', () => {
  const view = render(<ConversationMarkdown content="see https://example.com/docs" />);
  const link = view.container.querySelector('a')!;
  expect(link.getAttribute('href')).toBe('https://example.com/docs');
  const click = new MouseEvent('click', { bubbles: true, cancelable: true });
  fireEvent(link, click);
  expect(click.defaultPrevented).toBe(true);
  expect(opener.openUrl).toHaveBeenCalledWith('https://example.com/docs');
});
it('strips markdown for one-line previews', () => {
  expect(chatPlainText('**Hi** _there_, see [docs](https://x.y)\n- `a`')).toBe(
    'Hi there, see docs a',
  );
});
