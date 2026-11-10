import { notePageGeometry, type NotePageSettings } from './notePageLayout';

/** Snapshot rendered assets too: cloneNode alone drops canvas pixel contents. */
function printableClone(source: HTMLElement) {
  const clone = source.cloneNode(true) as HTMLElement;
  const canvases = source.querySelectorAll('canvas');
  clone.querySelectorAll('canvas').forEach((canvas, index) => {
    const image = document.createElement('img');
    try {
      image.src = canvases[index].toDataURL();
      image.width = canvases[index].clientWidth || canvases[index].width;
      image.height = canvases[index].clientHeight || canvases[index].height;
      image.alt = 'Math plot';
      canvas.replaceWith(image);
    } catch {
      canvas.replaceWith(document.createTextNode('Plot could not be prepared for printing.'));
    }
  });
  // Keep SVG references and footnotes within the printed copy, independent of
  // the offscreen renderer's IDs. One namespace spans all continuation pages.
  const prefix = `note-page-${crypto.randomUUID()}-`;
  const ids = new Map<string, string>();
  clone.querySelectorAll('[id]').forEach((element) => {
    ids.set(element.id, prefix + element.id);
    element.id = prefix + element.id;
  });
  clone.querySelectorAll('*').forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const value = attribute.value.replace(/url\(#([^)]*)\)/g, (original, id: string) =>
        ids.has(id) ? `url(#${ids.get(id)})` : original,
      );
      element.setAttribute(
        attribute.name,
        value.startsWith('#') && ids.has(value.slice(1)) ? `#${ids.get(value.slice(1))}` : value,
      );
    }
  });
  clone.querySelectorAll('button, [role="button"]').forEach((element) => element.remove());
  return clone;
}

/**
 * Fragment a rendered Markdown snapshot at actual browser layout boundaries.
 * Pages contain their own DOM, rather than repeated/clipped copies of a note.
 * The source renderer remains untouched so its React widgets can clean up.
 */
export function paginateNote(source: HTMLElement, target: HTMLElement, settings: NotePageSettings) {
  const geometry = notePageGeometry(settings);
  const snapshot = printableClone(source);
  // MarkdownPreview owns wrapper elements for its async renderers. They are
  // not document blocks and must not cause a page break around the whole note.
  snapshot.querySelectorAll('.markdown-preview').forEach((element) => {
    element.replaceWith(...Array.from(element.childNodes));
  });
  snapshot.querySelectorAll<HTMLElement>('div').forEach((element) => {
    if (element.style.display === 'contents')
      element.replaceWith(...Array.from(element.childNodes));
  });
  while (
    snapshot.children.length === 1 &&
    snapshot.firstElementChild?.tagName === 'DIV' &&
    !snapshot.firstElementChild.className
  ) {
    snapshot.firstElementChild.replaceWith(...Array.from(snapshot.firstElementChild.childNodes));
  }
  target.replaceChildren();
  let body: HTMLElement;
  let pages = 0;
  const ancestors: { source: HTMLElement; output: HTMLElement }[] = [];

  function makePage() {
    for (const ancestor of [...ancestors].reverse()) {
      if (
        !ancestor.output.textContent?.trim() &&
        !ancestor.output.querySelector('img, svg, hr, input')
      ) {
        ancestor.output.remove();
      }
    }
    if (pages >= 1000)
      throw new Error(
        'This note exceeds the 1,000-page print limit. Choose larger paper, narrower margins, or split it into smaller notes.',
      );
    const page = document.createElement('section');
    page.className = 'note-paper';
    page.setAttribute('aria-label', `Page ${++pages}`);
    page.style.width = `${geometry.width}px`;
    page.style.height = `${geometry.height}px`;
    page.style.padding = `${geometry.margin}px`;
    body = document.createElement('div');
    body.className = 'note-paper-body markdown-preview note-print-markdown';
    body.style.height = `${geometry.contentHeight - 1}px`;
    const footer = document.createElement('div');
    footer.className = 'note-paper-number';
    footer.textContent = String(pages);
    page.append(body, footer);
    target.append(page);
    let parent = body;
    for (const [index, ancestor] of ancestors.entries()) {
      const shell = ancestor.source.cloneNode(false) as HTMLElement;
      shell.removeAttribute('id');
      if (shell.tagName === 'OL') {
        const count = ancestor.output.querySelectorAll(':scope > li').length;
        const continuingItem = ancestors[index + 1]?.source.tagName === 'LI';
        const start = Number(ancestor.output.getAttribute('start') ?? 1);
        shell.setAttribute('start', String(start + count - (continuingItem ? 1 : 0)));
      }
      // Repeat table headers on continuation pages, without duplicate IDs.
      if (shell.tagName === 'TABLE') {
        const header = ancestor.source.querySelector(':scope > thead')?.cloneNode(true) as
          HTMLElement | undefined;
        header?.querySelectorAll('[id]').forEach((element) => element.removeAttribute('id'));
        header?.removeAttribute('id');
        if (header) shell.append(header);
      }
      parent.append(shell);
      ancestor.output = shell;
      parent = shell;
    }
  }
  const parent = () => ancestors[ancestors.length - 1]?.output ?? body;
  // Both measurements use the browser's integer rounding. Comparing against
  // floor(contentHeight) rejects even an empty body for fractional paper sizes.
  const fits = () => body.scrollHeight <= body.clientHeight;
  const hasContent = () => Boolean(body.textContent?.trim() || body.querySelector('img, svg, hr'));

  function appendText(node: Text) {
    let remaining = node.data;
    while (remaining.length) {
      const output = document.createTextNode(remaining);
      parent().append(output);
      if (fits()) return;
      let low = 0;
      let high = remaining.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        output.data = remaining.slice(0, middle);
        if (fits()) low = middle;
        else high = middle - 1;
      }
      let cut = low;
      const whitespace = remaining.slice(0, cut).search(/\s+\S*$/);
      if (whitespace > cut / 2) cut = whitespace + 1;
      if (/[\uD800-\uDBFF]$/.test(remaining.slice(0, cut))) cut--;
      output.data = remaining.slice(0, cut);
      if (!cut) {
        output.remove();
        // A single glyph must always make progress, even at extreme font sizes.
        if (!hasContent()) {
          const length = remaining.codePointAt(0)! > 0xffff ? 2 : 1;
          parent().append(document.createTextNode(remaining.slice(0, length)));
          remaining = remaining.slice(length);
        }
      } else remaining = remaining.slice(cut);
      if (remaining.length) makePage();
    }
  }

  function append(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      appendText(node as Text);
      return;
    }
    if (!(node instanceof HTMLElement) && !(node instanceof SVGElement)) return;
    const output = node.cloneNode(true) as HTMLElement;
    const hadContent = hasContent();
    parent().append(output);
    if (fits()) return;
    const range = document.createRange();
    range.selectNodeContents(output);
    const fullHeight = Math.max(
      output.getBoundingClientRect().height,
      range.getBoundingClientRect?.().height ?? 0,
    );
    output.remove();

    // Keep normal-sized blocks intact. Oversized blocks are recursively
    // fragmented, including nested lists, code, blockquotes and table bodies.
    if (
      hadContent &&
      fullHeight <= geometry.contentHeight &&
      !node.matches('tbody, thead, tfoot')
    ) {
      makePage();
      parent().append(output);
      if (fits()) return;
      output.remove();
    }
    if (node.matches('img, svg, hr, video, iframe, tr') || !node.childNodes.length) {
      const wrapper = document.createElement('div');
      wrapper.className = 'note-paper-scaled';
      wrapper.append(output);
      parent().append(wrapper);
      const height = output.getBoundingClientRect().height;
      const scale = Math.min(1, geometry.contentHeight / Math.max(1, height));
      output.style.transformOrigin = 'top left';
      output.style.transform = `scale(${scale})`;
      wrapper.style.height = `${height * scale}px`;
      wrapper.style.overflow = 'hidden';
      return;
    }
    const shell = node.cloneNode(false) as HTMLElement;
    parent().append(shell);
    ancestors.push({ source: node as HTMLElement, output: shell });
    for (const child of Array.from(node.childNodes)) append(child);
    ancestors.pop();
  }

  makePage();
  const children = Array.from(snapshot.childNodes);
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child instanceof HTMLElement && /^H[1-6]$/.test(child.tagName)) {
      let next = i + 1;
      while (
        next < children.length &&
        children[next].nodeType === Node.TEXT_NODE &&
        !children[next].textContent?.trim()
      )
        next++;
      if (next < children.length) {
        const group = document.createElement('div');
        group.style.display = 'contents';
        for (; i <= next; i++) group.append(children[i]);
        i--;
        append(group);
        continue;
      }
    }
    append(child);
  }
  target.querySelectorAll<HTMLElement>('.note-paper-number').forEach((footer, index) => {
    footer.textContent = `${index + 1} / ${pages}`;
  });
  return pages;
}
