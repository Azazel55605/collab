import { diffArrays } from 'diff';

type Edit = { start: number; end: number; lines: string[] };

function edits(base: string[], text: string): Edit[] {
  const result: Edit[] = [];
  let position = 0;
  let pending: Edit | undefined;
  for (const change of diffArrays(base, splitLines(text))) {
    if (!change.added && !change.removed) {
      if (pending) result.push(pending);
      pending = undefined;
      position += change.value.length;
      continue;
    }
    pending ??= { start: position, end: position, lines: [] };
    if (change.removed) {
      position += change.value.length;
      pending.end = position;
    } else {
      pending.lines.push(...change.value);
    }
  }
  if (pending) result.push(pending);
  return result;
}

function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function overlaps(a: Edit, b: Edit): boolean {
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  if (a.start === a.end) return a.start > b.start && a.start < b.end;
  if (b.start === b.end) return b.start > a.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

/**
 * Line-based three-way merge for plain-text documents (Phase 3 of the document
 * session & collaboration plan). Given a common `base` and two divergent
 * versions (`ours` = the dirty local content, `theirs` = the incoming remote
 * content), it returns the merged text when the two sides changed disjoint
 * regions, or `null` when their edits overlap and a human must reconcile them.
 *
 * This mirrors the backend's non-overlapping auto-merge (`write_note` with
 * `base_content`) on the frontend so a dirty note can absorb a clean remote
 * change without forcing the user to choose. It is intentionally format-blind
 * (operates on lines) and is injected into the note session controller as
 * `mergeRemote`; structured documents keep their own entity-level strategies.
 */
export function mergeText(base: string, ours: string, theirs: string): string | null {
  // Fast paths: if one side is unchanged from the base, the other side wins
  // outright. This avoids jsdiff quirks around trailing-newline-only deltas.
  if (ours === base) return theirs;
  if (theirs === base) return ours;
  if (ours === theirs) return ours;

  const lines = splitLines(base);
  const oursEdits = edits(lines, ours);
  const combined = [...oursEdits];
  for (const incoming of edits(lines, theirs)) {
    const identical = oursEdits.some(
      (local) =>
        local.start === incoming.start &&
        local.end === incoming.end &&
        local.lines.join('') === incoming.lines.join(''),
    );
    if (identical) continue;
    if (oursEdits.some((local) => overlaps(local, incoming))) return null;
    combined.push(incoming);
  }
  combined.sort((a, b) => a.start - b.start || a.end - b.end);
  const output: string[] = [];
  let position = 0;
  for (const edit of combined) {
    output.push(...lines.slice(position, edit.start), ...edit.lines);
    position = edit.end;
  }
  output.push(...lines.slice(position));
  return output.join('');
}
