/** Reconcile already-sanitized top-level blocks without throwing away hydrated assets. */
const signatures = new WeakMap<Element, string>();
export function reconcilePreviewBlocks(root: HTMLElement, sanitizedHtml: string) {
  const reusable = new Map<string, Element[]>();
  for (const block of Array.from(root.children)) {
    const signature = signatures.get(block);
    if (signature !== undefined) {
      const siblings = reusable.get(signature) ?? [];
      siblings.push(block);
      reusable.set(signature, siblings);
    }
  }
  const template = document.createElement('template');
  template.innerHTML = sanitizedHtml;
  const next: Element[] = [];
  for (const node of Array.from(template.content.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()) continue;
    const signature = node instanceof Element ? node.outerHTML : (node.textContent ?? '');
    let block = reusable.get(signature)?.shift();
    if (!block) {
      block = document.createElement('div');
      (block as HTMLElement).style.display = 'contents';
      block.appendChild(node);
      signatures.set(block, signature);
    }
    next.push(block);
  }
  // Move only changed/reordered nodes; unchanged images never detach or reload.
  let cursor = root.firstElementChild;
  for (const block of next) {
    if (cursor === block) cursor = cursor.nextElementSibling;
    else root.insertBefore(block, cursor);
  }
  while (cursor) {
    const stale = cursor;
    cursor = cursor.nextElementSibling;
    stale.remove();
  }
}
